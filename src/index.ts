import { Context, Logger, Schema } from "koishi";
import { ChatRequest, DefaultApi, Message } from "./chat";
import { Liquid } from "liquidjs";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
export const name = "sus-chat";

export interface Config {
  api: string;
  max_length: number;
  prompt_directory: string;
}

export const Config: Schema<Config> = Schema.object({
  api: Schema.string().default(DefaultApi),
  max_length: Schema.number().default(10).step(1),
  prompt_directory: Schema.path().default("./sus-chat"),
});

const logger = new Logger("sus-chat");
export async function apply(ctx: Context, config: Config) {
  const engine = new Liquid();
  let prompts = new Prompts(ctx, config.prompt_directory, engine);
  await prompts.init();
  ctx.command("sus <content:text>", "可疑").action(async (_, content) => {
    let node: Message = { role: "user", content };
    let req: ChatRequest = {
      model: "gpt-3.5-turbo",
      messages: [...prompts.get("hello"), node],
      stream: false,
    };
    let res = await ctx.http.post(config.api, req, { responseType: "json" });
    return res.choices[0].message.content;
  });
}
class Prompts {
  init_file_path: string;
  prompts_map: { [key: string]: Message[] } = {};
  init_object: any = {};
  liquid: Liquid;
  constructor(ctx: Context, directory: string, liquid: Liquid) {
    this.init_file_path = path.join(directory, "init.js");
    let files = fs
      .readdirSync(directory)
      .filter((file) => file.toLowerCase().endsWith(".yml"));
    let prompts: { name: string; content: Message[] }[] = files.map((file) => {
      let name = path.parse(file).name;
      console.log(file);

      let content_string = fs.readFileSync(path.join(directory, file), "utf-8");
      let content = YAML.parse(content_string);
      return { name, content };
    });
    prompts.forEach((prompt) => {
      this.prompts_map[prompt.name] = prompt.content;
    });
    this.liquid = liquid;
  }
  async init() {
    if (fs.existsSync(this.init_file_path)) {
      try {
        this.init_object = await import(this.init_file_path);
      } catch (e) {
        logger.error(e);
      }
    }
  }
  get(name: string, scope: { [key: string]: any }): Message[] {
    if (!this.prompts_map[name]) {
      throw "prompt not found";
    }
    let temp = this.prompts_map[name];
    let messages: Message[] = temp.map((message) => {
      const content = this.liquid.parseAndRenderSync(message.content, {
        ...scope,
        ...this.init_object,
      });
      return { role: message.role, content };
    });
    return messages;
  }
}
