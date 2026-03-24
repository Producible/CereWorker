import { z } from 'zod';

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
  auth: z.enum(['apikey', 'oauth']).default('apikey'),
  oauth: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      callbackPort: z.number().default(18888),
    })
    .optional(),
});

export const configSchema = z.object({
  profile: z
    .object({
      name: z.string().default('Cere'),
      role: z.string().default('general-purpose assistant'),
      traits: z.array(z.string()).default([]),
    })
    .default({}),

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
              model: z.string().default('llama3.3'),
            })
            .optional(),
        })
        .default({}),
      maxSteps: z.number().default(10),
      temperature: z.number().default(0.7),
      contextWindow: z.number().default(128000),
      compaction: z
        .object({
          enabled: z.boolean().default(true),
          threshold: z.number().default(0.8),
          keepRecentMessages: z.number().default(10),
        })
        .default({}),
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
          image: z.string().default('cereworker/cerebellum'),
          modelsPath: z.string().default('~/.cereworker/models'),
          composeFile: z.string().optional(),
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
          autoMode: z.boolean().default(false),
        })
        .default({}),
      fileOps: z
        .object({
          enabled: z.boolean().default(true),
          rootDir: z.string().optional(),
        })
        .default({}),
      http: z
        .object({
          enabled: z.boolean().default(true),
          timeout: z.number().default(30000),
          maxResponseSize: z.number().default(102400),
          allowPrivate: z.boolean().default(false),
        })
        .default({}),
      web: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({}),
      browser: z
        .object({
          enabled: z.boolean().default(true),
          mode: z.enum(['launch', 'connect']).default('launch'),
          cdpPort: z.number().default(9222),
          headless: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),

  channels: z
    .object({
      dmPolicy: z.enum(['pairing', 'open']).default('pairing'),
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

  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      file: z.string().optional(),
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

  gateway: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['gateway', 'node', 'standalone']).default('standalone'),
      port: z.number().default(18800),
      token: z.string().optional(),
      invokeTimeoutMs: z.number().default(60000),
      pingIntervalMs: z.number().default(30000),
      gatewayUrl: z.string().optional(),
      nodeId: z.string().optional(),
      capabilities: z.array(z.string()).default([]),
    })
    .default({}),
});

export type CereWorkerConfig = z.infer<typeof configSchema>;
