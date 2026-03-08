import { streamText, type CoreMessage, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { Message } from '@cereworker/core';
import type { CerebrumConfig, ProviderConfig, StreamCallbacks } from './types.js';
import { createBuiltinTools, type BuiltinTools } from './tools/index.js';

export class CerebrumProvider {
  private config: CerebrumConfig;
  private builtinTools: BuiltinTools;

  constructor(config: CerebrumConfig, shellConfig?: { denyList?: string[]; timeout?: number; maxOutputSize?: number }) {
    this.config = config;
    this.builtinTools = createBuiltinTools(shellConfig);
  }

  private getModel(provider?: string, model?: string): LanguageModel {
    const providerName = provider ?? this.config.defaultProvider;
    const modelName = model ?? this.config.defaultModel;
    const providerConfig = this.config.providers[providerName];

    switch (providerName) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey: providerConfig?.apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return anthropic(modelName);
      }
      case 'openai': {
        const openai = createOpenAI({
          apiKey: providerConfig?.apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return openai(modelName);
      }
      case 'google': {
        const google = createGoogleGenerativeAI({
          apiKey: providerConfig?.apiKey,
          ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
        });
        return google(modelName);
      }
      case 'local': {
        // Local models via OpenAI-compatible API (e.g., Ollama, vLLM)
        const local = createOpenAI({
          apiKey: providerConfig?.apiKey ?? 'not-needed',
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
    callbacks: StreamCallbacks,
    options?: { provider?: string; model?: string; systemPrompt?: string; maxSteps?: number },
  ): Promise<void> {
    const model = this.getModel(options?.provider, options?.model);
    const coreMessages = this.convertMessages(messages);

    try {
      const result = streamText({
        model,
        messages: coreMessages,
        tools: this.builtinTools,
        maxSteps: options?.maxSteps ?? this.config.maxSteps,
        temperature: this.config.temperature,
        ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
      });

      let fullContent = '';

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            fullContent += part.textDelta;
            callbacks.onChunk(part.textDelta);
            break;
          case 'tool-call':
            await callbacks.onToolCall({
              id: part.toolCallId,
              name: part.toolName,
              args: part.args as Record<string, unknown>,
            });
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
    }
  }

  getDefaultProvider(): string {
    return this.config.defaultProvider;
  }

  getDefaultModel(): string {
    return this.config.defaultModel;
  }
}
