import { z } from 'zod';

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
});

export const configSchema = z.object({
  cerebrum: z
    .object({
      defaultProvider: z.string().default('anthropic'),
      defaultModel: z.string().default('claude-sonnet-4-6'),
      providers: z
        .object({
          anthropic: providerConfigSchema.optional(),
          openai: providerConfigSchema.optional(),
          google: providerConfigSchema.optional(),
          local: providerConfigSchema
            .extend({
              baseUrl: z.string().default('http://localhost:11434'),
              model: z.string().default('llama3'),
            })
            .optional(),
        })
        .default({}),
      maxSteps: z.number().default(10),
      temperature: z.number().default(0.7),
    })
    .default({}),

  cerebellum: z
    .object({
      enabled: z.boolean().default(true),
      address: z.string().default('localhost:50051'),
      heartbeatInterval: z.number().default(30),
      model: z
        .object({
          source: z.enum(['huggingface', 'local']).default('huggingface'),
          id: z.string().default('Qwen/Qwen3-0.6B'),
          path: z.string().optional(),
        })
        .default({}),
      finetune: z
        .object({
          enabled: z.boolean().default(true),
          method: z.enum(['auto', 'lora', 'qlora', 'full']).default('auto'),
          schedule: z.enum(['auto', 'hourly', 'daily', 'weekly']).default('auto'),
        })
        .default({}),
      verification: z
        .object({
          enabled: z.boolean().default(true),
          timeoutMs: z.number().default(5000),
        })
        .default({}),
      docker: z
        .object({
          autoStart: z.boolean().default(true),
          image: z.string().default('cereworker-cerebellum'),
        })
        .default({}),
    })
    .default({}),

  tools: z
    .object({
      shell: z
        .object({
          enabled: z.boolean().default(true),
          denyList: z.array(z.string()).default(['rm -rf /']),
          timeout: z.number().default(30000),
          maxOutputSize: z.number().default(102400),
        })
        .default({}),
      fileOps: z
        .object({
          enabled: z.boolean().default(true),
          rootDir: z.string().optional(),
        })
        .default({}),
    })
    .default({}),

  channels: z
    .object({
      slack: z
        .object({
          enabled: z.boolean().default(false),
          botToken: z.string().optional(),
          appToken: z.string().optional(),
          signingSecret: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
      discord: z
        .object({
          enabled: z.boolean().default(false),
          token: z.string().optional(),
          applicationId: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
      telegram: z
        .object({
          enabled: z.boolean().default(false),
          token: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
      matrix: z
        .object({
          enabled: z.boolean().default(false),
          homeserver: z.string().default('https://matrix.org'),
          token: z.string().optional(),
          userId: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
      feishu: z
        .object({
          enabled: z.boolean().default(false),
          appId: z.string().optional(),
          appSecret: z.string().optional(),
          verificationToken: z.string().optional(),
          encryptKey: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
      wechat: z
        .object({
          enabled: z.boolean().default(false),
          puppet: z.string().default('wechaty-puppet-wechat4u'),
          token: z.string().optional(),
          allowFrom: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),

  hippocampus: z
    .object({
      enabled: z.boolean().default(true),
      directory: z.string().default('~/.cereworker/memory'),
      maxDailyLogDays: z.number().default(30),
      autoLog: z.boolean().default(true),
    })
    .default({}),

  subAgents: z
    .object({
      enabled: z.boolean().default(true),
      maxConcurrent: z.number().default(5),
      defaultTimeoutMinutes: z.number().default(5),
      monitorIntervalSeconds: z.number().default(30),
      stallThresholdSeconds: z.number().default(120),
    })
    .default({}),

  tui: z
    .object({
      theme: z.enum(['dark', 'light', 'auto']).default('auto'),
      maxDisplayMessages: z.number().default(100),
    })
    .default({}),

  skills: z
    .object({
      directories: z.array(z.string()).default([]),
      enabled: z.array(z.string()).default([]),
    })
    .default({}),
});

export type CereWorkerConfig = z.infer<typeof configSchema>;
