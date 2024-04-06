import { Context, Logger, Schema } from "koishi";
import { ChatRequest,  Message } from "./chat";
import { DefaultApi } from "./defaultapi";
import { Liquid } from "liquidjs";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
export const name = "sus-chat";

export interface Config {
  api: string;
  api_key: string;
  max_length: number;
  prompt_directory: string;
}

export const Config: Schema<Config> = Schema.object({
  api: Schema.string().default(DefaultApi.url),
  api_key: Schema.string().default(DefaultApi.key),
  max_length: Schema.number().default(10).step(1),
  prompt_directory: Schema.path().default("./sus-chat"),
});

const logger = new Logger("sus-chat");
export function apply(ctx: Context, config: Config) {
  const engine = new Liquid();
  let prompts = new Prompts(ctx, config.prompt_directory, engine);
  ctx.command("sus <content:text>", "可疑").action(async (s, content) => {
    let node: Message = { role: "user", content };
    let req: ChatRequest = {
      model: "gpt-3.5-turbo",
      messages: [
        ...prompts.get("hello", {
          session: JSON.parse(JSON.stringify(s.session)),
        }),
        node,
      ],
      stream: false,
    };
    let res = await ctx.http.post(config.api, req, {
      responseType: "json",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.api_key}`,
      },
    });
    return res.choices[0].message.content;
  });
  ctx.command("sus.prom").action(async (s) => {
    s.session.channel;
    return JSON.stringify(
      prompts.get("hello", {
        session: JSON.parse(JSON.stringify(s.session)),
      })
    );
  });
  ctx.command("sus.reload").action(() => {
    prompts = new Prompts(ctx, config.prompt_directory, engine);
    return "重载完成";
  });
}
class Prompts {
  prompts_map: { [key: string]: Message[] } = {};
  liquid: Liquid;
  constructor(ctx: Context, directory: string, liquid: Liquid) {
    let init_file_path = path.join(directory, "init.js");
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
    let prompts: { name: string; content: Message[] }[] = files.map((file) => {
      let name = path.parse(file).name;
      let content_string = fs.readFileSync(path.join(directory, file), "utf-8");
      let content = YAML.parse(content_string);
      return { name, content };
    });
    prompts.forEach((prompt) => {
      this.prompts_map[prompt.name] = prompt.content;
    });
    this.liquid = liquid;
  }
  get(name: string, scope: { [key: string]: any }): Message[] {
    if (!this.prompts_map[name]) {
      throw "prompt not found";
    }
    let temp = this.prompts_map[name];
    let messages: Message[] = temp.map((message) => {
      const content = this.liquid.parseAndRenderSync(message.content, scope);
      return { role: message.role, content };
    });
    return messages;
  }
}
