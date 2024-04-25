import { Context, Logger, Session } from "koishi";
import { ChatServer, Message, Prompts, PromptsReal } from "./chat";
import YAML from "yaml";
import { Config } from "./config";

export const name = "sus-chat";
export { Config } from "./config";

export const usage = `
默认API由热心网友提供，如果想要感谢他：[**爱发电**]()

如果意外触发，请检查关键词。
`;

class Collected {
  collected: { [cid: string]: string[] } = {};
  max_length: number;
  constructor(max_length: number) {
    this.max_length = max_length;
  }
  get(cid: string) {
    return this.collected[cid] ?? [];
  }
  add(cid: string, content: string) {
    this.collected[cid] = [...(this.collected[cid] ?? []), content];
    while (this.collected[cid].length > this.max_length) {
      this.collected[cid].shift();
    }
  }
  clean(cid: string) {
    delete this.collected[cid];
  }
}

export const logger = new Logger("sus-chat");
export function apply(ctx: Context, config: Config) {
  const collected: Collected = new Collected(
    config.functionality.extension_count,
  );
  const current_prompt = new CurrentPropmptName(
    config.prompt.default_prompt ?? "",
  );
  const server = new ChatServer(
    config.api,
    config.api_key,
    { max_length: config.max_length },
    config.prompt.pro_prompt
      ? new Prompts(ctx, config.prompt.prompt_directory)
      : config.prompt.prompt_str,
  );
  server.persistence = config.functionality.persistence;
  if (config.functionality.persistence) server.load_recollect(ctx);
  async function chat(
    session: Session,
    content: string,
  ): Promise<string | null> {
    const prompt_real: PromptsReal = await server.get_prompt(
      current_prompt.get(session.cid),
      session,
    );
    const my_content = prompt_real.postprocessing({
      role: "user",
      content: content,
    });
    const message: Message = {
      role: "user",
      content: [...collected.get(session.cid), my_content.content].join("\n"),
    };
    if (config.functionality.logging) {
      logger.info(`${session.cid}:`, JSON.stringify(message.content));
    }
    collected.clean(session.cid);
    const result = await server.chat(
      message,
      current_prompt.get(session.cid),
      ctx,
      session,
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
        return server.prompts.names.join("\n");
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
        const result = server.prompts.get(name, s.session);
        return YAML.stringify(result.prompts);
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
      const result = await server.evaluate(s.session, content);
      return result;
    });
  ctx.command("sus.history", "查看聊天记录").action((s) => {
    return YAML.stringify(
      server.get_recollect(s.session, current_prompt.get(s.session.cid)),
    );
  });
  ctx.command("sus.history.clean", "清空聊天记录").action((s) => {
    server.update_recollect(
      ctx,
      s.session,
      current_prompt.get(s.session.cid),
      (_) => [],
    );
    return "清空成功";
  });

  // 随机回复与关键词触发
  ctx.middleware(async (session, next) => {
    const content = session.content;
    let for_key = false;
    for (const key of config.functionality.tiggering.keywords
      .keywords_for_triggering) {
      if (content.includes(key)) {
        for_key = true;
        break;
      }
    }
    const for_random =
      config.functionality.tiggering.random_reply.enable &&
      Math.random() < config.functionality.tiggering.random_reply.probability;
    if (!(for_key || for_random)) return next();
    if (
      config.functionality.tiggering.random_reply.effect_for_keywords &&
      !(for_key && for_random)
    )
      return next();
    const result = await chat(session, content);
    return result ?? next();
  });
  if (config.functionality.extension_count >= 1) {
    ctx.middleware(async (session, next) => {
      const postprocessing = (
        await server.get_prompt(current_prompt.get(session.cid), session)
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
