import { useState, useEffect, useCallback } from 'react';
import type { Orchestrator, Message } from '@cereworker/core';

export interface ChatState {
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  activeToolCall: string | null;
  error: string | null;
}

export function useChat(orchestrator: Orchestrator) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      orchestrator.on('message:user', ({ message }) => {
        setMessages((prev) => [...prev, message]);
      }),
    );

    unsubs.push(
      orchestrator.on('message:cerebrum:start', () => {
        setIsStreaming(true);
        setStreamingContent('');
        setError(null);
      }),
    );

    unsubs.push(
      orchestrator.on('message:cerebrum:chunk', ({ chunk }) => {
        setStreamingContent((prev) => prev + chunk);
      }),
    );

    unsubs.push(
      orchestrator.on('message:cerebrum:end', ({ message }) => {
        setMessages((prev) => [...prev, message]);
        setStreamingContent('');
        setIsStreaming(false);
      }),
    );

    unsubs.push(
      orchestrator.on('message:cerebrum:toolcall', ({ toolCall }) => {
        setActiveToolCall(toolCall.name);
      }),
    );

    unsubs.push(
      orchestrator.on('tool:end', ({ result }) => {
        setActiveToolCall(null);
        setMessages((prev) => [
          ...prev,
          {
            id: result.callId,
            role: 'tool' as const,
            content: result.output,
            toolResult: result,
            timestamp: Date.now(),
          },
        ]);
      }),
    );

    unsubs.push(
      orchestrator.on('error', ({ error: err }) => {
        setError(err.message);
        setIsStreaming(false);
        setStreamingContent('');
        setActiveToolCall(null);
      }),
    );

    return () => unsubs.forEach((u) => u());
  }, [orchestrator]);

  const sendMessage = useCallback(
    async (content: string) => {
      setError(null);
      await orchestrator.sendMessage(content);
    },
    [orchestrator],
  );

  return { messages, isStreaming, streamingContent, activeToolCall, error, sendMessage };
}
