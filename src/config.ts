import { Schema } from "koishi";

export interface Config {
  api: string;
  api_key: string;
  model: string;
  temperature: number;
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
    logging: boolean;
    tiggering: {
      random_reply: {
        enable: boolean;
        probability?: number;
      };
      keywords: {
        keywords_for_triggering: string[];
        use_regex: boolean;
      };
      when_direct_reply: boolean;
    };
  };
}

export const Config: Schema<Config> = Schema.object({
  api: Schema.string().description("API").required(),
  api_key: Schema.string().description("KEY").required(),
  model: Schema.string().default("gpt-3.5-turbo").description("模型"),
  max_length: Schema.number()
    .role("slider")
    .min(3)
    .max(50)
    .default(10)
    .step(1)
    .description("记忆长度上限"),
  temperature: Schema.number()
    .role("slider")
    .min(0.0)
    .max(2.0)
    .step(0.0001)
    .default(0.5)
    .description("默认温度(会受高阶提示词影响)"),
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
          .required()
          .description("提示词文件所在目录"),
        default_prompt: Schema.computed(Schema.string().required()).description(
          "默认提示词"
        ),
      }),
    ]),
  ]),
  functionality: Schema.object({
    persistence: Schema.boolean()
      .default(true)
      .description("是否将消息记录持久化"),
    extension_count: Schema.number()
      .default(0)
      .max(10)
      .step(1)
      .min(0)
      .description("追溯上下文条目数量"),
    logging: Schema.boolean()
      .default(false)
      .description("是否于每句对话输出日志"),
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
              .step(0.001)
              .role("slider")
              .description("随机回复概率"),
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
      when_direct_reply: Schema.boolean()
        .default(false)
        .description("是否于私聊时无需任何方式，直接触发"),
    }),
  }).description("功能性"),
});
