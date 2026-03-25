import { streamText, generateText, tool, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Message, ToolCall as CWToolCall, ToolDefinition } from '@cereworker/core';
import type { CerebrumConfig, ProviderConfig, StreamCallbacks } from './types.js';
import { createBuiltinTools, type BuiltinTools } from './tools/index.js';
import { withRetry, type RetryOptions } from './retry.js';
import { buildCompactionPrompt } from './context.js';
import { TokenStore, refreshAccessToken, OAUTH_PROVIDERS } from './oauth/index.js';
import { refreshOpenAIToken, refreshGoogleToken } from './oauth/pi-auth.js';

function friendlyApiError(error: unknown, provider: string, model: string): string {
  if (!(error instanceof Error)) return String(error);
  const msg = error.message;

  // Location restriction (Google)
  if (msg.includes('User location is not supported')) {
    return `${provider} model "${model}" is not available in your region. Try a different model (e.g. gemini-2.0-flash) or switch providers with /provider.`;
  }

  // Auth errors
  if (msg.includes('invalid_api_key') || msg.includes('Incorrect API key') || msg.includes('401')) {
    return `Invalid API key for ${provider}. Check your key in ~/.cereworker/config.yaml or set the appropriate environment variable.`;
  }

  // Rate limits
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return `Rate limit exceeded for ${provider}. Wait a moment and try again, or switch providers with /provider.`;
  }

  // Model not found
  if (msg.includes('model not found') || msg.includes('does not exist') || msg.includes('404')) {
    return `Model "${model}" not found on ${provider}. Check the model name or use /model to switch.`;
  }

  // Context length
  if (msg.includes('context length') || msg.includes('too many tokens') || msg.includes('maximum')) {
    return `Message too long for ${model}. Try shortening your message or start a new conversation.`;
  }

  // Billing/permissions
  if (msg.includes('billing') || msg.includes('payment') || msg.includes('403')) {
    return `Access denied for ${provider}. Check your billing/plan at the provider's dashboard.`;
  }

  // Network
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('fetch failed')) {
    return `Cannot reach ${provider}. Check your internet connection.`;
  }

  // Fall back to the original message but strip the class name prefix
  return msg.replace(/^[A-Za-z_]+Error \[AI_[A-Za-z]+\]: /, '');
}

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

  private convertMessages(messages: Message[]): ModelMessage[] {
    const result: ModelMessage[] = [];

    for (const m of messages) {
      if (m.role === 'system' || m.role === 'cerebellum') continue;

      if (m.role === 'user') {
        result.push({ role: 'user', content: m.content } as ModelMessage);
        continue;
      }

      if (m.role === 'cerebrum') {
        if (m.toolCalls?.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const content: any[] = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const tc of m.toolCalls) {
            content.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.args,
            });
          }
          result.push({ role: 'assistant', content } as ModelMessage);
        } else {
          result.push({ role: 'assistant', content: m.content } as ModelMessage);
        }
        continue;
      }

      if (m.role === 'tool' && m.toolResult) {
        result.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: m.toolResult.callId,
            toolName: (m.metadata?.toolName as string) ?? 'unknown',
            output: { type: 'text', value: m.content },
          }],
        } as unknown as ModelMessage);
        continue;
      }

      // Fallback: treat unknown roles as user
      result.push({ role: 'user', content: m.content } as ModelMessage);
    }

    return result;
  }

  /** Drop tool messages not preceded by an assistant message with matching tool calls. */
  private sanitizeToolPairing(messages: ModelMessage[]): ModelMessage[] {
    const result: ModelMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const prev = result[result.length - 1];
        if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
          const hasToolCalls = (prev.content as Array<{ type: string }>).some(
            (p) => p.type === 'tool-call',
          );
          if (hasToolCalls) {
            result.push(msg);
            continue;
          }
        }
        // Drop orphaned tool messages
        continue;
      }
      result.push(msg);
    }

    return result;
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
    const coreMessages = this.sanitizeToolPairing(this.convertMessages(nonSystemMessages));

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

    for (const [name, def] of Object.entries(externalTools)) {
      const schema = isZodSchema(def.parameters)
        ? (def.parameters as unknown as z.ZodTypeAny)
        : z.record(z.unknown());

      convertedTools[name] = tool({
        description: def.description,
        inputSchema: schema,
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
          stopWhen: stepCountIs(options?.maxSteps ?? 10),
          temperature: this.config.temperature,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        });

        let fullContent = '';
        const collectedToolCalls: CWToolCall[] = [];

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              fullContent += part.text;
              callbacks.onChunk(part.text);
              break;
            case 'tool-call':
              collectedToolCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: (part as { input?: unknown }).input as Record<string, unknown> ?? {},
              });
              break;
            case 'error':
              callbacks.onError(
                part.error instanceof Error ? part.error : new Error(String(part.error)),
              );
              break;
          }
        }

        callbacks.onFinish(fullContent, collectedToolCalls.length > 0 ? collectedToolCalls : undefined);
      } catch (error) {
        const provider = options?.provider ?? this.config.defaultProvider;
        const modelName = options?.model ?? this.config.defaultModel;
        const friendly = friendlyApiError(error, provider, modelName);
        callbacks.onError(new Error(friendly));
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
