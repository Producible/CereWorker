import type { Message, ToolCall, ToolResult, StreamFinishMetadata } from '@cereworker/core';

export interface CerebrumConfig {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, ProviderConfig>;
  maxSteps: number;
  temperature: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  model?: string;
  auth?: 'apikey' | 'oauth';
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    callbackPort?: number;
  };
}

export interface CerebrumRequest {
  messages: Message[];
  systemPrompt?: string;
  model?: string;
  provider?: string;
  maxSteps?: number;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onToolCall: (toolCall: ToolCall) => Promise<ToolResult>;
  onFinish: (content: string, toolCalls?: ToolCall[], meta?: StreamFinishMetadata) => void;
  onError: (error: Error) => void;
}
