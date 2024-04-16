import { Schema } from "koishi";
import { DefaultApi } from "./defaultapi";

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
  functionality: {
    persistence: boolean;
    extension_count: number;
    tiggering: {
      random_reply: {
        enable: boolean;
        probability?: number;
        effect_for_keywords?: boolean;
      };
      keywords: {
        keywords_for_triggering: string[];
        use_regex: boolean;
      };
    };
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
      pro_prompt: Schema.boolean().default(false).description("使用高阶提示词"),
    }).description("提示词"),
    Schema.union([
      Schema.object({
        pro_prompt: Schema.const(false),
        prompt_str: Schema.string()
          .default(
            "你是个有用的助理，当前与你对话的用户的昵称为:{{ session.user.name }}"
          )
          .description("提示词内容"),
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
  functionality: Schema.object({
    persistence: Schema.boolean()
      .default(true)
      .description("是否将消息记录持久化"),
    extension_count: Schema.number()
      .default(1)
      .max(10)
      .step(1)
      .min(1)
      .description("追溯上下文条目数量"),
    tiggering: Schema.object({
      random_reply: Schema.intersect([
        Schema.object({
          enable: Schema.boolean()
            .default(false)
            .description("是否启用随机回复"),
        }).description("随机回复"),
        Schema.union([
          Schema.object({
            enable: Schema.const(false),
          }),
          Schema.object({
            enable: Schema.const(true).required(),
            probability: Schema.number()
              .default(0.5)
              .min(0)
              .max(1)
              .step(0.05)
              .role("slider")
              .description("随机回复概率"),
            effect_for_keywords: Schema.boolean()
              .description("是否影响关键词匹配")
              .default(false),
          }),
        ]),
      ]),
      keywords: Schema.object({
        keywords_for_triggering: Schema.array(Schema.string())
          .default([])
          .description("触发关键词 (提示词文件中也可写 keywords)"),
        use_regex: Schema.boolean()
          .default(false)
          .description("关键词是否使用正则表达式"),
      }).description("关键词触发"),
    }),
  }).description("功能性"),
});
