import fs from "node:fs";
import {
  Context as LContext,
  Emitter,
  Hash,
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
import { logger } from ".";
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
}
export interface PromptsFileReal {
  name: string;
  prompts: { role: Role; content: Template[] }[];
  postprocessing?: Template[];
}
export interface PromptsReal {
  postprocessing: (message: Message) => Message;
  prompts: Message[];
}
export class Prompts {
  prompts_map: {
    [key: string]: PromptsFileReal;
  } = {};
  liquid: Liquid;
  reload(ctx: Context, directory: string) {
    const liquid = new Liquid();
    register_first(liquid);
    const init_file_path = path.join(directory, "init.js");
    if (fs.existsSync(init_file_path)) {
      liquid.plugin((Liquid) => {
        let fun: (
          this: Liquid,
          arg0: Context,
          arg1: typeof Liquid
        ) => void = require(init_file_path);
        fun.bind(this)(ctx, Liquid);
      });
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
    prompts.forEach((prompt) => {
      const prompts: { role: Role; content: Template[] }[] = prompt.prompts.map(
        (prompt) => {
          return { role: prompt.role, content: liquid.parse(prompt.content) };
        }
      );
      const postprocessing = prompt.postprocessing
        ? liquid.parse(prompt.postprocessing)
        : undefined;
      this.prompts_map[prompt.name] = {
        name: prompt.name,
        prompts,
        postprocessing,
      };
    });
    this.liquid = liquid;
  }
  constructor(ctx: Context, directory: string) {
    this.reload(ctx, directory);
  }
  get names(): string[] {
    return Object.keys(this.prompts_map);
  }
  get(name: string, session: Session): PromptsReal {
    register(session);
    if (!this.prompts_map[name]) {
      throw "prompt not found";
    }
    const temp = this.prompts_map[name];
    const messages: Message[] = temp.prompts.map((message) => {
      const content = this.liquid.renderSync(message.content, {
        session: JSON.parse(JSON.stringify(session)),
      });
      return { role: message.role, content };
    });
    let postprocessing: (message: Message) => Message;
    if (temp.postprocessing) {
      postprocessing = (message: Message) => {
        const content: string = this.liquid.renderSync(temp.postprocessing, {
          message: message,
          session: JSON.parse(JSON.stringify(session)),
        });
        return { role: message.role, content: content.trim() };
      };
    } else {
      postprocessing = (message: Message) => message;
    }
    return { prompts: messages, postprocessing };
  }
}
export interface ChatConfig {
  max_length: number;
}
export class ChatServer {
  prompts?: Prompts | undefined;
  prompt_str?: Template[] | undefined;
  #liquid?: Liquid | undefined;
  api: { url: string; key: string };
  #recollect: { [cid: string]: { [prompt_name: string]: Message[] } };
  max_length: number;
  persistence: boolean;
  get liquid() {
    return this.#liquid ?? this.prompts.liquid;
  }
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
  constructor(
    apiurl: string,
    apikey: string,
    config: ChatConfig,
    prompts: Prompts | string
  ) {
    this.#recollect = {};
    this.max_length = config.max_length;
    if (typeof prompts === "string") {
      this.#liquid = new Liquid();
      this.prompt_str = this.#liquid.parse(prompts);
    } else {
      this.prompts = prompts;
    }
    this.api = { url: apiurl, key: apikey };
  }
  async evaluate(session: Session, content: string): Promise<string> {
    register(session);
    return (
      (await this.liquid.parseAndRender(content, {
        session: JSON.parse(JSON.stringify(session)),
      })) ?? content
    );
  }
  async get_prompt(
    prompt_name: string,
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
      };
    } else {
      return this.prompts.get(prompt_name, session);
    }
  }
  async chat(
    message: Message,
    prompt_name: string,
    ctx: Context,
    session: Session
  ): Promise<Message | undefined> {
    const recall = this.get_recollect(session, prompt_name);
    console.log(recall);

    const prompt_real: PromptsReal = await this.get_prompt(
      prompt_name,
      session
    );
    const req: ChatRequest = {
      model: "gpt-3.5-turbo",
      messages: [...recall, ...prompt_real.prompts, message],
      stream: false,
    };
    const res = await ctx.http.post(this.api.url, req, {
      responseType: "json",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.api.key}`,
      },
    });
    const result_p = prompt_real.postprocessing(res.choices[0].message);
    const result = result_p.content.trim() == "" ? undefined : result_p;
    this.update_recollect(ctx, session, prompt_name, (messages) => {
      messages.push(message);
      messages.push(result ?? result_p);
      return messages;
    });
    return result;
  }
}

function register(session: Session) {
  Current.session = session;
}
function register_first(engine: Liquid) {
  engine.registerTag("send", Send);
}
class Send extends Tag {
  private value: Value;
  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    this.value = new Value(token.args, liquid);
  }
  *render(ctx: LContext, _emitter: Emitter) {
    const str: string = yield this.value.value(ctx);
    Current.session.send(str);
  }
}

class Current {
  static session: Session;
}
