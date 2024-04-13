import fs from "node:fs";
import { Liquid, Template } from "liquidjs";
import { Context, Session } from "koishi";
import path from "node:path";
import YAML from "yaml";
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
  get(name: string, scope: { [key: string]: any }): PromptsReal {
    if (!this.prompts_map[name]) {
      throw "prompt not found";
    }
    const temp = this.prompts_map[name];
    const messages: Message[] = temp.prompts.map((message) => {
      const content = this.liquid.renderSync(message.content, scope);
      return { role: message.role, content };
    });
    let postprocessing;
    if (temp.postprocessing) {
      postprocessing = (message: Message) => {
        const content = this.liquid.renderSync(temp.postprocessing, {
          message: message,
          ...scope,
        });
        console.log(content);

        return { role: message.role, content };
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
    cid: string,
    prompt_name: string,
    callback: (messages: Message[]) => Message[]
  ) {
    if (!this.#recollect[cid]) {
      this.#recollect[cid] = {};
    }
    if (!this.#recollect[cid][prompt_name]) {
      this.#recollect[cid][prompt_name] = [];
    }
    this.#recollect[cid][prompt_name] = callback(
      this.#recollect[cid][prompt_name]
    );
    this.#limit_length();
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
  async chat(
    message: Message,
    prompt_name: string,
    ctx: Context,
    session: Session
  ): Promise<Message> {
    prompt_name = prompt_name ?? "#";
    if (typeof this.recollect[session.cid] === "undefined") {
      this.recollect[session.cid] = {};
    }
    if (typeof this.recollect[session.cid][prompt_name] === "undefined") {
      this.recollect[session.cid][prompt_name] = [];
    }
    const recall = this.recollect[session.cid][prompt_name];
    let prompt_real: PromptsReal;
    if (typeof this.prompts === "undefined") {
      prompt_real = {
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
      prompt_real = this.prompts.get(prompt_name, {
        session: JSON.parse(JSON.stringify(session)),
      });
    }
    const my_message = prompt_real.postprocessing(message);
    const req: ChatRequest = {
      model: "gpt-3.5-turbo",
      messages: [...recall, ...prompt_real.prompts, my_message],
      stream: false,
    };
    const res = await ctx.http.post(this.api.url, req, {
      responseType: "json",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.api.key}`,
      },
    });
    const result = prompt_real.postprocessing(res.choices[0].message);
    this.update_recollect(session.cid, prompt_name, (messages) => {
      messages.push(my_message);
      messages.push(result);
      return messages;
    });
    return result;
  }
}
