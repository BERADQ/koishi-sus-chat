import { Context, Logger, Schema } from "koishi";
import { ChatServer, Message, Prompts } from "./chat";
import { DefaultApi } from "./defaultapi";
export const name = "sus-chat";

export interface Config {
  api: string;
  api_key: string;
  max_length: number;
  prompt: {
    pro_prompt: boolean;
    prompt_str?: string;
    prompt_directory?: string;
    default_prompt?: string;
  };
}

export const Config: Schema<Config> = Schema.object({
  api: Schema.string().default(DefaultApi.url).description("API"),
  api_key: Schema.string().default(DefaultApi.key).description("KEY"),
  max_length: Schema.number()
    .role("slider")
    .min(3)
    .max(50)
    .default(10)
    .step(1)
    .description("记忆长度上限"),
  prompt: Schema.intersect([
    Schema.object({
      pro_prompt: Schema.boolean().default(false).description("使用专业提示词"),
    }),
    Schema.union([
      Schema.object({
        pro_prompt: Schema.const(false),
        prompt_str: Schema.string()
          .default(
            "你是个有用的助理，当前与你对话的用户的昵称为:{{ session.user.name }}"
          )
          .description("提示词"),
      }),
      Schema.object({
        pro_prompt: Schema.const(true).required(),
        prompt_directory: Schema.path({
          filters: ["directory"],
        })
          .default("./sus-chat")
          .description("提示词文件所在目录"),
        default_prompt: Schema.string()
          .default("default")
          .description("默认提示词"),
      }),
    ]),
  ]),
});

const logger = new Logger("sus-chat");
export function apply(ctx: Context, config: Config) {
  const server = new ChatServer(
    config.api,
    config.api_key,
    { max_length: config.max_length },
    config.prompt.pro_prompt
      ? new Prompts(ctx, config.prompt.prompt_directory)
      : config.prompt.prompt_str
  );
  ctx.command("sus <content:text>", "可疑").action(async (s, content) => {
    const node: Message = { role: "user", content };
    const result = await server.chat(
      node,
      config.prompt.default_prompt,
      ctx,
      s.session
    );
    return result.content;
  });
  if (config.prompt.pro_prompt)
    ctx.command("sus.prom [name:string]").action(async (s, name) => {
      if (!config.prompt?.pro_prompt) {
        return server.liquid.render(server.prompt_str, {
          session: JSON.parse(JSON.stringify(s.session)),
        });
      }
      if (!name) {
        return server.prompts.names.join("\n");
      }
      return JSON.stringify(
        server.prompts.get(name, {
          session: JSON.parse(JSON.stringify(s.session)),
        })
      );
    });
  ctx.command("sus.eval <content:text>").action(async (s, content) => {
    const result = await server.liquid.parseAndRender(content, {
      session: JSON.parse(JSON.stringify(s.session)),
    });
    return result;
  });
  if (config.prompt.pro_prompt)
    ctx.command("sus.reload").action(() => {
      server.prompts?.reload(ctx, config.prompt.prompt_directory);
    });
}
