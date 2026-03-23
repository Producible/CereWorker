export interface SystemPromptOptions {
  cerebellumConnected: boolean;
  tools: Map<string, { description: string }>;
  autoMode: boolean;
  gatewayMode: 'standalone' | 'gateway' | 'node';
  connectedNodes?: number;
  gatewayUrl?: string;
  profile?: { name: string; role: string; traits: string[] };
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Identity
  if (options.profile?.name && options.profile.name !== 'Cere') {
    sections.push(`You are ${options.profile.name}, the Cerebrum of CereWorker, a dual-LLM autonomous agent.`);
  } else {
    sections.push('You are the Cerebrum of CereWorker, a dual-LLM autonomous agent.');
  }

  // Profile
  const profileLines: string[] = [];
  if (options.profile?.role && options.profile.role !== 'general-purpose assistant') {
    profileLines.push(`Your primary role is: ${options.profile.role}.`);
  }
  if (options.profile?.traits?.length) {
    profileLines.push(`Your communication style: ${options.profile.traits.join(', ')}.`);
  }
  if (profileLines.length > 0) {
    sections.push(`## Profile\n${profileLines.join('\n')}`);
  }

  // Architecture
  const cerebellumStatus = options.cerebellumConnected ? 'connected' : 'offline';
  sections.push(`## Architecture
You are the reasoning brain — you handle complex thinking, planning, conversation, and tool use.
The Cerebellum is a small local model (Qwen3 0.6B) that acts as your watchdog:
- It verifies your tool results by checking actual side effects (file exists? modified recently?)
- It handles scheduling decisions and emergency stops
- It does NOT reason — it only answers yes/no binary questions
- Status: ${cerebellumStatus}. ${options.cerebellumConnected ? 'Your tool results are independently verified.' : 'When offline, your tool results are not independently verified.'}`);

  // Available tools
  if (options.tools.size > 0) {
    const toolLines = Array.from(options.tools.entries())
      .map(([name, def]) => `- **${name}**: ${def.description}`)
      .join('\n');
    sections.push(`## Available Tools\n${toolLines}`);
  }

  // Operating mode
  const execMode = options.autoMode ? 'full-auto' : 'supervised';
  const execExplanation = options.autoMode
    ? 'Commands execute without user approval. The Cerebellum pre-screens destructive operations.'
    : 'Unknown or destructive commands require user approval before execution.';

  let gatewayLine: string;
  switch (options.gatewayMode) {
    case 'gateway':
      gatewayLine = `Gateway hub with ${options.connectedNodes ?? 0} node(s) connected`;
      break;
    case 'node':
      gatewayLine = `Node connected to gateway at ${options.gatewayUrl ?? 'unknown'}`;
      break;
    default:
      gatewayLine = 'Standalone (single instance)';
  }

  sections.push(`## Operating Mode
- Exec safety: ${execMode}. ${execExplanation}
- Gateway: ${gatewayLine}`);

  // Guidelines
  sections.push(`## Guidelines
- Use tools to take real actions. Don't just describe what you would do — do it.
- When the Cerebellum flags a warning on your tool output, pay attention and self-correct.
- For destructive operations, prefer confirming with the user first.`);

  return sections.join('\n\n');
}
