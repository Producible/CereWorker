import { streamText, generateText, tool, type CoreMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Message, ToolDefinition } from '@cereworker/core';
import type { CerebrumConfig, ProviderConfig, StreamCallbacks } from './types.js';
import { createBuiltinTools, type BuiltinTools } from './tools/index.js';
import { withRetry, type RetryOptions } from './retry.js';
import { buildCompactionPrompt } from './context.js';
import { TokenStore, refreshAccessToken, OAUTH_PROVIDERS } from './oauth/index.js';
import { refreshOpenAIToken, refreshGoogleToken } from './oauth/pi-auth.js';

export class CerebrumProvider {
  private config: CerebrumConfig;
  private builtinTools: BuiltinTools;
  private retryOptions: RetryOptions;
  private tokenStore = new TokenStore();

  constructor(
    config: CerebrumConfig,
    shellConfig?: Partial<import('./tools/shell.js').ShellToolConfig>,
    retryOptions?: RetryOptions,
  ) {
    this.config = config;
    this.builtinTools = createBuiltinTools(shellConfig);
    this.retryOptions = retryOptions ?? {};
  }

  private async resolveApiKey(
    providerName: string,
    providerConfig?: ProviderConfig,
  ): Promise<string | undefined> {
    if (providerConfig?.auth !== 'oauth') {
      return providerConfig?.apiKey;
    }

    const tokens = this.tokenStore.load(providerName);
    if (!tokens) {
      throw new Error(
        `No OAuth tokens found for ${providerName}. Run: cereworker auth ${providerName}`,
      );
    }

    if (this.tokenStore.isExpired(tokens)) {
      if (!tokens.refreshToken) {
        throw new Error(
          `OAuth token expired and no refresh token. Run: cereworker auth ${providerName}`,
        );
      }

      let refreshed;
      if (providerName === 'openai') {
        refreshed = await refreshOpenAIToken(tokens.refreshToken);
      } else if (providerName === 'google') {
        refreshed = await refreshGoogleToken(tokens.refreshToken, tokens.projectId ?? '');
      } else {
        const oauthConfig = OAUTH_PROVIDERS[providerName];
        if (!oauthConfig) throw new Error(`No OAuth config for ${providerName}`);
        refreshed = await refreshAccessToken(
          oauthConfig,
          tokens.refreshToken,
          tokens.clientId ?? providerConfig.oauth?.clientId,
          providerConfig.oauth?.clientSecret,
        );
      }

      this.tokenStore.save(providerName, refreshed);
      return refreshed.accessToken;
    }

    return tokens.accessToken;
  }

  private async getModel(provider?: string, model?: string): Promise<LanguageModel> {
    const providerName = provider ?? this.config.defaultProvider;
    const modelName = model ?? this.config.defaultModel;
    const providerConfig = this.config.providers[providerName];
    const apiKey = await this.resolveApiKey(providerName, providerConfig);

    switch (providerName) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return anthropic(modelName);
      }
      case 'openai': {
        const openai = createOpenAI({
          apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return openai(modelName);
      }
      case 'google': {
        const google = createGoogleGenerativeAI({
          apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return google(modelName);
      }
      case 'local': {
        const local = createOpenAI({
          apiKey: apiKey ?? 'not-needed',
          baseURL: providerConfig?.baseUrl ?? 'http://localhost:11434/v1',
        });
        return local(providerConfig?.model ?? modelName);
      }
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  private convertMessages(messages: Message[]): CoreMessage[] {
    return messages
      .filter((m) => m.role !== 'system' && m.role !== 'cerebellum')
      .map((m) => {
        switch (m.role) {
          case 'user':
            return { role: 'user' as const, content: m.content };
          case 'cerebrum':
            return { role: 'assistant' as const, content: m.content };
          case 'tool':
            return {
              role: 'tool' as const,
              content: [
                {
                  type: 'tool-result' as const,
                  toolCallId: m.toolResult?.callId ?? '',
                  toolName: m.metadata?.toolName as string ?? 'unknown',
                  result: m.content,
                },
              ],
            };
          default:
            return { role: 'user' as const, content: m.content };
        }
      });
  }

  async stream(
    messages: Message[],
    externalTools: Record<string, ToolDefinition>,
    callbacks: StreamCallbacks,
    options?: { provider?: string; model?: string; systemPrompt?: string; maxSteps?: number },
  ): Promise<void> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const model = await this.getModel(options?.provider, options?.model);
    const coreMessages = this.convertMessages(nonSystemMessages);

    const systemParts: string[] = [];
    if (options?.systemPrompt) systemParts.push(options.systemPrompt);
    for (const sm of systemMessages) {
      systemParts.push(sm.content);
    }
    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    // Convert orchestrator-registered tools to AI SDK format.
    // Their execute delegates to onToolCall so the orchestrator handles
    // execution, verification, and persistence in one place.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convertedTools: Record<string, any> = {};
    const externalToolNames = new Set<string>();

    for (const [name, def] of Object.entries(externalTools)) {
      externalToolNames.add(name);
      const schema = isZodSchema(def.parameters)
        ? (def.parameters as unknown as z.ZodTypeAny)
        : z.record(z.unknown());

      convertedTools[name] = tool({
        description: def.description,
        parameters: schema,
        execute: async (args, { toolCallId }) => {
          const result = await callbacks.onToolCall({
            id: toolCallId,
            name,
            args: args as Record<string, unknown>,
          });
          return result.output;
        },
      });
    }

    const allTools = { ...this.builtinTools, ...convertedTools };

    await withRetry(async () => {
      try {
        const result = streamText({
          model,
          messages: coreMessages,
          tools: allTools,
          maxSteps: options?.maxSteps ?? this.config.maxSteps,
          temperature: this.config.temperature,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        });

        let fullContent = '';

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              fullContent += part.textDelta;
              callbacks.onChunk(part.textDelta);
              break;
            case 'tool-call':
              // External tools already call onToolCall via their execute function,
              // so only fire onToolCall here for builtin tools.
              if (!externalToolNames.has(part.toolName)) {
                await callbacks.onToolCall({
                  id: part.toolCallId,
                  name: part.toolName,
                  args: part.args as Record<string, unknown>,
                });
              }
              break;
            case 'error':
              callbacks.onError(
                part.error instanceof Error ? part.error : new Error(String(part.error)),
              );
              break;
          }
        }

        callbacks.onFinish(fullContent);
      } catch (error) {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }, this.retryOptions);
  }

  getDefaultProvider(): string {
    return this.config.defaultProvider;
  }

  getDefaultModel(): string {
    return this.config.defaultModel;
  }

  setProvider(provider: string): void {
    this.config.defaultProvider = provider;
  }

  setModel(model: string): void {
    this.config.defaultModel = model;
  }

  /**
   * Summarize a list of messages into a concise summary via a single LLM call.
   * Used for context window compaction.
   */
  async summarize(messages: Message[]): Promise<string> {
    const model = await this.getModel();
    const prompt = buildCompactionPrompt(messages);

    const result = await withRetry(async () => {
      const { text } = await generateText({
        model,
        prompt,
        temperature: 0.3,
      });
      return text;
    }, this.retryOptions);

    return result;
  }

  /** Single-shot text generation from a raw prompt. */
  async generate(prompt: string): Promise<string> {
    const model = await this.getModel();
    const result = await withRetry(async () => {
      const { text } = await generateText({
        model,
        prompt,
        temperature: 0.3,
      });
      return text;
    }, this.retryOptions);
    return result;
  }
}

/** Duck-type check: does this look like a Zod schema? */
function isZodSchema(obj: unknown): boolean {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '_def' in (obj as Record<string, unknown>) &&
    typeof (obj as Record<string, unknown>).parse === 'function'
  );
}
