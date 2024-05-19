import fs from "node:fs";
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
import yaml from "js-yaml";
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
export interface MessageTemplate {
  role: Role;
  content: Template[];
}

export interface PromptsFile<M = Message[]> {
  extend?: string | null;
  name: string;
  prompts?: M | null;
  postprocessing?: string | null;
  keywords?: string[] | null;
  follow?: boolean | null;
  config: unknown | null;
}
export interface PromptsReal {
  postprocessing: (message: Message) => Message;
  prompts?: Message[] | null;
  follow: boolean;
  config: unknown | undefined;
}
export class Prompts {
  origin_config: Config;
  directory: string;
  prompts_map: {
    [key: string]: PromptsFile<MessageTemplate[]>;
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
      const content: PromptsFile = yaml.load(content_string) as PromptsFile;
      return content;
    });
    const liquid = this.get_liquid(ctx);
    prompts.forEach((prompt) => {
      const prompts: { role: Role; content: Template[] }[] =
        prompt.prompts?.map((prompt) => {
          return { role: prompt.role, content: liquid.parse(prompt.content) };
        });
      this.prompts_map[prompt.name] = Object.assign({}, prompt, {
        prompts: prompts,
      });
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
    const messages: Message[] | null = temp.prompts?.map((message) => {
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
    let target: PromptsReal = {
      prompts: messages ?? [],
      postprocessing,
      follow: !!temp.follow,
      config: temp.config,
    };
    if (typeof temp.extend == "string") {
      target = Object.assign(
        {},
        this.get(temp.extend, ctx, session),
        filterUndefined(target)
      );
    }
    return target;
  }
}
export class ChatServer {
  prompts?: Prompts | undefined;
  prompt_str?: Template[] | undefined;
  #liquid?: Liquid | undefined;
  #recollect: { [cid: string]: { [prompt_name: string]: Message[] } };
  max_length: number;
  persistence: boolean;
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
        config: undefined,
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
    if (message.content.trim() == "" || typeof message.content != "string") {
      return undefined;
    }
    const prompt_real: PromptsReal = await this.get_prompt(
      prompt_name,
      ctx,
      session
    );
    let messages: Message[];
    if (prompt_real?.follow) {
      messages = [...recall, ...(prompt_real.prompts ?? []), message];
    } else {
      messages = [...(prompt_real.prompts ?? []), ...recall, message];
    }
    const url = prompt_real.config?.["apiUrl"] ?? this.origin_config.api;

    const req = Object.assign(
      {},
      {
        model: this.origin_config.model,
        messages: messages,
        temperature: this.origin_config.temperature,
        stream: false,
      },
      filterUndefined({
        model: prompt_real.config?.["model"],
        max_tokens: prompt_real.config?.["max_tokens"],
        temperature: prompt_real.config?.["temperature"],
        top_p: prompt_real.config?.["top_p"],
        frequency_penalty: prompt_real.config?.["frequency_penalty"],
        presence_penalty: prompt_real.config?.["presence_penalty"],
        stop: prompt_real.config?.["stop"],
        logit_bias: prompt_real.config?.["logit_bias"],
        prompt: prompt_real.config?.["prompt"],
      })
    );

    console.log(req);
    const res = await ctx.http(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(
          prompt_real.config?.["apiToken"] ?? this.origin_config.api_key
        ).trim()}`,
      },
      data: JSON.stringify(req),
    });

    const result_p = prompt_real.postprocessing(res.data.choices[0].message);
    const result = result_p.content.trim() == "" ? undefined : result_p;
    this.update_recollect(ctx, session, prompt_name, (messages) => {
      messages.push(message);
      messages.push(result ?? res.data.choices[0].message);
      return messages;
    });
    if (this.origin_config.functionality.logging) {
      logger.info("assistant:", res.data.choices[0]?.message?.content);
    }
    return result;
  }
}
function filterUndefined(obj: any) {
  const filtered = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined) {
      // 如果值不是 undefined，则将其添加到过滤后的对象中
      filtered[key] = obj[key];
    }
  });
  return filtered;
}
