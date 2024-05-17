import { Context, Logger, Session } from "koishi";
import { ChatServer, Message, Prompts, PromptsReal } from "./chat";
import yaml from "js-yaml";
import { Config } from "./config";

export const name = "sus-chat";
export { Config } from "./config";

export const usage = `
# 使用方法可查看: [**文档**](https://beradq.github.io/sus-chat-doc)
`;

class Collected {
  collected: { [cid: string]: string[] } = {};
  max_length: number;
  constructor(max_length: number) {
    this.max_length = max_length;
  }
  get(cid: string) {
    this.collected[cid]?.shift();
    return this.collected[cid] ?? [];
  }
  add(cid: string, content: string) {
    this.collected[cid] = [...(this.collected[cid] ?? []), content];
    while (this.collected[cid].length > this.max_length) {
      this.collected[cid].shift();
    }
  }
  clean(cid: string) {
    this.collected[cid] = [];
  }
}

export const logger = new Logger("sus-chat");
export function apply(ctx: Context, config: Config) {
  const collected: Collected = new Collected(
    config.functionality.extension_count
  );
  const current_prompt = new CurrentPropmptName(config);
  const server = new ChatServer(
    config,
    config.prompt.pro_prompt
      ? new Prompts(ctx, config.prompt.prompt_directory, config)
      : config.prompt.prompt_str
  );
  server.persistence = config.functionality.persistence;
  if (config.functionality.persistence) server.load_recollect(ctx);
  async function chat(
    session: Session,
    content: string
  ): Promise<string | null> {
    const prompt_real: PromptsReal = await server.get_prompt(
      current_prompt.get(session.cid),
      ctx,
      session
    );
    const my_content = prompt_real.postprocessing({
      role: "user",
      content: content,
    });
    const message: Message = {
      role: "user",
      content: [...collected.get(session.cid), my_content.content].join("\n\n"),
    };
    if (config.functionality.logging) {
      logger.info(`${session.cid}:`, message.content);
    }
    collected.clean(session.cid);
    const result = await server.chat(
      message,
      current_prompt.get(session.cid),
      ctx,
      session
    );
    return result?.content;
  }
  ctx.command("sus <content:text>", "与Ai聊天").action(async (s, content) => {
    return chat(s.session, content);
  });
  if (config.prompt.pro_prompt) {
    ctx
      .command("sus.prom", "提示词相关指令,直接输入可查看提示词列表")
      .action(async (_s) => {
        return server.prompts.names
          .filter((v) => !v.startsWith("."))
          .join("\n");
      });
    ctx
      .command("sus.prom.set <name:string>", "设置提示词")
      .action(async (s, name) => {
        if (!Object.keys(server.prompts.prompts_map).includes(name))
          return "提示词不存在";
        current_prompt.set(s.session.cid, name);
        return "设置成功";
      });
    ctx
      .command("sus.prom.exec <name:string>", "求值提示词")
      .action(async (s, name) => {
        const result = server.prompts.get(name, ctx, s.session);
        return yaml.dump(result.prompts);
      });
    ctx.command("sus.prom.current", "查看当前提示词").action((s) => {
      return current_prompt.get(s.session.cid);
    });
    ctx.command("sus.reload", "重新载入所有提示词").action(() => {
      server.prompts?.reload(ctx, config.prompt.prompt_directory);
      return "重载成功";
    });
  }
  ctx
    .command("sus.eval <content:text>", "求值 liquid")
    .action(async (s, content) => {
      const result = await server.evaluate(ctx, s.session, content);
      return result;
    });
  ctx.command("sus.history", "查看聊天记录").action((s) => {
    return yaml.dump(
      server.get_recollect(s.session, current_prompt.get(s.session.cid))
    );
  });
  ctx.command("sus.history.clean", "清空聊天记录").action((s) => {
    server.update_recollect(
      ctx,
      s.session,
      current_prompt.get(s.session.cid),
      (_) => []
    );
    collected.clean(s.session.cid);
    return "清空成功";
  });

  // 随机回复与关键词触发与私聊触发
  ctx.middleware(async (session, next) => {
    const content = session.content;
    session.isDirect
    let for_key = false;
    const keywords = [
      ...server.prompts?.get_keywords(current_prompt.get(session.cid)),
      ...config.functionality.tiggering.keywords.keywords_for_triggering,
    ];
    for (const key of keywords) {
      if (content.includes(key)) {
        for_key = true;
        break;
      }
    }
    const for_random =
      config.functionality.tiggering.random_reply.enable &&
      Math.random() < config.functionality.tiggering.random_reply.probability;
    const for_direct = config.functionality.tiggering.when_direct_reply && session.isDirect;
    if (!(for_key || for_random || for_direct)) return next();
    const result = await chat(session, content);
    return result ?? next();
  });
  if (config.functionality.extension_count >= 1) {
    ctx.middleware(async (session, next) => {
      const postprocessing = (
        await server.get_prompt(current_prompt.get(session.cid), ctx, session)
      ).postprocessing;
      const message: Message = {
        role: "user",
        content: session.content,
      };
      const result = postprocessing(message);
      collected.add(session.cid, result.content);
      return next();
    });
  }
}
class CurrentPropmptName {
  current_name: { [key: string]: string } = {};
  config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  get(id: string) {
    return this.current_name[id] ?? this.config.prompt.default_prompt ?? "";
  }
  set(id: string, name: string) {
    this.current_name[id] = name;
  }
}
