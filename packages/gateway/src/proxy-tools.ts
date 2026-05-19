import type { ToolDefinition, ToolExecutionContext } from '@producible/cereworker-core';
import type { GatewayServer } from './server.js';

export function createProxyTools(
  server: GatewayServer,
  nodeId: string,
  capabilities: string[],
): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {};

  for (const cap of capabilities) {
    const toolName = `${cap}@${nodeId}`;
    tools[toolName] = {
      description: `Execute "${cap}" on remote node "${nodeId}"`,
      parameters: {},
      execute: async (args, context?: ToolExecutionContext) => {
        return server.invoke(nodeId, cap, args, {
          conversationId: context?.conversationId,
          sessionId: context?.sessionKey ?? context?.turnId,
          turnId: context?.turnId,
          attempt: context?.attempt,
          callId: context?.callId,
          requestedToolName: context?.toolName,
          scopeKey: context?.scopeKey,
        });
      },
    };
  }

  return tools;
}
