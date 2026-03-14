import type { ToolDefinition } from '@cereworker/core';
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
      execute: async (args) => {
        return server.invoke(nodeId, cap, args);
      },
    };
  }

  return tools;
}
