import { Context, Logger } from "koishi";
import { ChatServer, Message, Prompts } from "./chat";
import YAML from "yaml";
import { Config } from "./config";

export const name = "sus-chat";
export { Config } from "./config";

export const logger = new Logger("sus-chat");
export function apply(ctx: Context, config: Config) {
  const collected: string[] = [];
  const current_prompt = new CurrentPropmptName(
    config.prompt.default_prompt ?? ""
  );
  const server = new ChatServer(
    config.api,
    config.api_key,
    { max_length: config.max_length },
    config.prompt.pro_prompt
      ? new Prompts(ctx, config.prompt.prompt_directory)
      : config.prompt.prompt_str
  );
  server.persistence = config.functionality.persistence;
  if (config.functionality.persistence) server.load_recollect();
  ctx.command("sus <content:text>", "与Ai聊天").action(async (s, content) => {
    const node: Message = {
      role: "user",
      content: [...collected, content].join("\n"),
    };
    const result = await server.chat(
      node,
      current_prompt.get(s.session.channelId),
      ctx,
      s.session
    );
    return result?.content;
  });
  if (config.prompt.pro_prompt) {
    ctx
      .command("sus.prom", "提示词相关指令,直接输入可查看提示词列表")
      .action(async (_s) => {
        return server.prompts.names.join("\n");
      });
    ctx
      .command("sus.prom.set <name:string>", "设置提示词")
      .action(async (s, name) => {
        current_prompt.set(s.session.channelId, name);
        return "设置成功";
      });
    ctx
      .command("sus.prom.exec <name:string>", "求值提示词")
      .action(async (s, name) => {
        const result = server.prompts.get(name, s.session);
        return YAML.stringify(result.prompts);
      });
    ctx.command("sus.prom.current", "查看当前提示词").action((s) => {
      return current_prompt.get(s.session.channelId);
    });
    ctx.command("sus.reload", "重新载入所有提示词").action(() => {
      server.prompts?.reload(ctx, config.prompt.prompt_directory);
      return "重载成功";
    });
  }
  ctx
    .command("sus.eval <content:text>", "求值 liquid")
    .action(async (s, content) => {
      const result = await server.evaluate(s.session, content);
      return result;
    });
  ctx.command("sus.history", "查看聊天记录").action((s) => {
    return YAML.stringify(
      server.get_recollect(s.session, current_prompt.get(s.session.channelId))
    );
  });
  ctx.command("sus.history.clean", "清空聊天记录").action((s) => {
    server.update_recollect(
      s.session.channelId,
      current_prompt.get(s.session.channelId),
      (_) => []
    );
  });

  if (config.functionality.random_reply.enable) {
    ctx.middleware(async (session, next) => {
      if (Math.random() < config.functionality.random_reply.probability) {
        const message: Message = {
          role: "user",
          content: [...collected, session.content].join("\n"),
        };
        const result = await server.chat(
          message,
          current_prompt.get(session.channelId),
          ctx,
          session
        );
        return result?.content ?? next();
      }
      return next();
    });
  }
  if (config.functionality.extension_count > 1) {
    ctx.middleware(async (session, next) => {
      const postprocessing = (
        await server.get_prompt(current_prompt.get(session.channelId), session)
      ).postprocessing;
      const message: Message = {
        role: "user",
        content: session.content,
      };
      const result = postprocessing(message);
      collected.push(result.content);
      while (collected.length > config.functionality.extension_count) {
        collected.shift();
      }
      return next();
    });
  }
}
class CurrentPropmptName {
  current_name: { [key: string]: string } = {};
  default_prompt: string;
  constructor(default_prompt: string) {
    this.default_prompt = default_prompt;
  }
  get(id: string) {
    return this.current_name[id] ?? this.default_prompt;
  }
  set(id: string, name: string) {
    this.current_name[id] = name;
  }
}
