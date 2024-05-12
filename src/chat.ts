import fs from "node:fs";
import OpenAI from "openai";
import {
  Context as LContext,
  Emitter,
  Liquid,
  Tag,
  TagToken,
  Template,
  TopLevelToken,
  Value,
} from "liquidjs";
import { Context, Session } from "koishi";
import path from "node:path";
import YAML from "yaml";
import { Config, logger } from "./index";
export interface ChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
}
type Role = "user" | "system" | "assistant";
export interface Message {
  role: Role;
  content: string;
}

export interface PromptsFile {
  name: string;
  prompts: Message[];
  postprocessing?: string;
  keywords?: string[] | undefined;
  follow?: boolean | undefined;
  temperature?: number | undefined;
}
export interface PromptsFileReal {
  name: string;
  prompts: { role: Role; content: Template[] }[];
  postprocessing?: string;
  keywords?: string[];
  follow: boolean;
  temperature: number;
}
export interface PromptsReal {
  postprocessing: (message: Message) => Message;
  prompts: Message[];
  follow: boolean;
  temperature: number;
}
export class Prompts {
  origin_config: Config;
  directory: string;
  prompts_map: {
    [key: string]: PromptsFileReal;
  } = {};
  init_func?: (this: Liquid, arg0: Context, arg1: typeof Liquid) => void;
  get_liquid(ctx?: Context, session?: Session): Liquid {
    const liquid = new Liquid();
    if (!!ctx && !!this.init_func) {
      const init_func = this.init_func;
      liquid.plugin(function (Liquid) {
        init_func.call(this, ctx, Liquid);
      });
    }
    liquid.registerTag("send", {
      *render(ctx, emitter, hash) {
        const str = yield this.value.value(ctx);
        session?.send(str);
      },
      parse(token, remainingTokens) {
        this.value = new Value(token.args, this.liquid);
      },
    });
    return liquid;
  }
  reload(ctx: Context, directory: string) {
    logger.info("load prompts");
    const init_file_path = path.join(directory, "init.js");
    if (fs.existsSync(init_file_path)) {
      this.init_func = require(path.resolve(path.join(init_file_path)));
    }
    let files = fs
      .readdirSync(directory)
      .filter((file) => file.toLowerCase().endsWith(".yml"));
    let prompts: PromptsFile[] = files.map((file) => {
      const content_string = fs.readFileSync(
        path.join(directory, file),
        "utf-8"
      );
      const content: PromptsFile = YAML.parse(content_string);
      return content;
    });
    const liquid = this.get_liquid(ctx);
    prompts.forEach((prompt) => {
      const prompts: { role: Role; content: Template[] }[] = prompt.prompts.map(
        (prompt) => {
          return { role: prompt.role, content: liquid.parse(prompt.content) };
        }
      );
      this.prompts_map[prompt.name] = {
        name: prompt.name,
        prompts,
        postprocessing: prompt.postprocessing,
        keywords: prompt.keywords,
        follow: !!prompt.follow,
        temperature: prompt.temperature ?? this.origin_config.temperature,
      };
    });
  }
  constructor(ctx: Context, directory: string, config: Config) {
    this.origin_config = config;
    this.reload(ctx, directory);
  }
  get names(): string[] {
    return Object.keys(this.prompts_map);
  }
  get_keywords(name: string): string[] {
    return this.prompts_map[name]?.keywords ?? [];
  }
  get(name: string, ctx: Context, session: Session): PromptsReal {
    const liquid = this.get_liquid(ctx, session);
    if (!this.prompts_map[name]) {
      throw "prompt not found";
    }
    const temp = this.prompts_map[name];
    const messages: Message[] = temp.prompts.map((message) => {
      const content = liquid.renderSync(message.content, {
        session: JSON.parse(JSON.stringify(session)),
      });
      return { role: message.role, content };
    });
    let postprocessing: (message: Message) => Message;
    if (temp.postprocessing) {
      postprocessing = (message: Message) => {
        const content: string = liquid.parseAndRenderSync(temp.postprocessing, {
          message: message,
          session: JSON.parse(JSON.stringify(session)),
        });
        return { role: message.role, content: content.trim() };
      };
    } else {
      postprocessing = (message: Message) => message;
    }
    return {
      prompts: messages,
      postprocessing,
      follow: !!temp.follow,
      temperature: temp.temperature,
    };
  }
}
export class ChatServer {
  prompts?: Prompts | undefined;
  prompt_str?: Template[] | undefined;
  #liquid?: Liquid | undefined;
  #recollect: { [cid: string]: { [prompt_name: string]: Message[] } };
  max_length: number;
  persistence: boolean;
  openai: OpenAI;
  origin_config: Config;
  get recollect() {
    return this.#recollect;
  }
  set recollect(value) {
    this.#recollect = value;
    this.#limit_length();
  }
  get_recollect(session: Session, prompt_name: string) {
    return this.recollect[session.cid]?.[prompt_name] ?? [];
  }
  #limit_length() {
    for (const cid in this.#recollect) {
      for (const prompt_name in this.#recollect[cid]) {
        while (this.#recollect[cid][prompt_name].length > this.max_length) {
          this.#recollect[cid][prompt_name].shift();
        }
      }
    }
  }
  update_recollect(
    ctx: Context,
    session: Session | { cid: string },
    prompt_name: string,
    callback: (messages: Message[]) => Message[]
  ) {
    if (typeof this.#recollect[session.cid] == "undefined") {
      this.#recollect[session.cid] = {};
    }
    if (typeof this.#recollect[session.cid][prompt_name] == "undefined") {
      this.#recollect[session.cid][prompt_name] = [];
    }
    this.#recollect[session.cid][prompt_name] = callback(
      this.#recollect[session.cid][prompt_name]
    );
    this.#limit_length();
    if (this.persistence) {
      const dir = path.join(
        ctx.baseDir,
        "data",
        "sus-recollect",
        encodeURIComponent(session.cid)
      );
      const file = `${encodeURIComponent(prompt_name)}.json`;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
      fs.writeFileSync(
        `${dir}/${file}`,
        JSON.stringify(this.#recollect[session.cid][prompt_name]),
        {
          encoding: "utf-8",
        }
      );
    }
  }
  load_recollect(ctx: Context) {
    const dir = path.join(ctx.baseDir, "data", "sus-recollect");
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      logger.info("no recollect data");
      return;
    }
    const subdirectories = items?.filter((item) => item.isDirectory());
    for (const subdirectory of subdirectories) {
      const cid = decodeURIComponent(subdirectory.name);
      const files = fs
        .readdirSync(`${dir}/${subdirectory.name}`)
        .filter((file) => file.toLowerCase().endsWith(".json"));
      for (const file of files) {
        const prompt_name = decodeURIComponent(file.slice(0, -5));
        const content = fs.readFileSync(
          `${dir}/${subdirectory.name}/${file}`,
          "utf-8"
        );
        this.update_recollect(ctx, { cid }, prompt_name, (_messages) => {
          return JSON.parse(content) as Message[];
        });
      }
    }
  }
  constructor(config: Config, prompts: Prompts | string) {
    this.#recollect = {};
    this.max_length = config.max_length;
    if (typeof prompts === "string") {
      this.#liquid = new Liquid();
      this.prompt_str = this.#liquid.parse(prompts);
    } else {
      this.prompts = prompts;
    }
    this.openai = new OpenAI({ baseURL: config.api, apiKey: config.api_key });
    this.origin_config = config;
  }
  get_liquid(ctx?: Context, session?: Session): Liquid {
    return this.#liquid ?? this.prompts.get_liquid(ctx, session);
  }
  async evaluate(
    ctx: Context,
    session: Session,
    content: string
  ): Promise<string> {
    return (
      (await this.get_liquid(ctx, session).parseAndRender(content, {
        session: JSON.parse(JSON.stringify(session)),
      })) ?? content
    );
  }
  async get_prompt(
    prompt_name: string,
    ctx: Context,
    session: Session
  ): Promise<PromptsReal> {
    if (typeof this.prompts === "undefined") {
      return {
        prompts: [
          {
            role: "system",
            content: await this.#liquid.render(this.prompt_str, {
              session: JSON.parse(JSON.stringify(session)),
            }),
          },
        ],
        postprocessing: (message) => message,
        follow: false,
        temperature: this.origin_config.temperature,
      };
    } else {
      return this.prompts.get(prompt_name, ctx, session);
    }
  }
  async chat(
    message: Message,
    prompt_name: string,
    ctx: Context,
    session: Session
  ): Promise<Message | undefined> {
    const recall = this.get_recollect(session, prompt_name);
    if (message.content.trim() == "") {
      return undefined;
    }
    const prompt_real: PromptsReal = await this.get_prompt(
      prompt_name,
      ctx,
      session
    );
    let messages: Message[];
    if (prompt_real) {
      messages = [...recall, ...prompt_real.prompts, message];
    } else {
      messages = [...prompt_real.prompts, ...recall, message];
    }
    const res = await this.openai.chat.completions.create({
      stream: false,
      messages,
      model: this.origin_config.model,
      temperature: prompt_real.temperature,
      max_tokens: this.origin_config.max_tokens,
      top_p: this.origin_config.top_p,
      frequency_penalty: this.origin_config.frequency_penalty,
      presence_penalty: this.origin_config.presence_penalty,
    });

    const result_p = prompt_real.postprocessing(res.choices[0].message);
    const result = result_p.content.trim() == "" ? undefined : result_p;
    this.update_recollect(ctx, session, prompt_name, (messages) => {
      messages.push(message);
      messages.push(result ?? res.choices[0].message);
      return messages;
    });
    if (this.origin_config.functionality.logging) {
      logger.info("assistant:", res.choices[0]?.message?.content);
    }
    return result;
  }
}
