export interface RecurringTask {
  id: string;
  goal: string;
  schedule: string;
}

export interface SystemPromptOptions {
  cerebellumConnected: boolean;
  tools: Map<string, { description: string }>;
  autoMode: boolean;
  gatewayMode: 'standalone' | 'gateway' | 'node';
  connectedNodes?: number;
  gatewayUrl?: string;
  profile?: { name: string; role: string; traits: string[] };
  finetuneStatus?: { enabled: boolean; status: string; progress?: number; lastJobId?: string };
  recurringTasks?: RecurringTask[];
}

const TOOL_CATEGORIES: Record<string, string[]> = {
  'File & Code': ['shell', 'readFile', 'writeFile', 'editFile', 'listDirectory', 'searchFiles', 'glob'],
  'Memory': ['memory_read', 'memory_write', 'memory_log', 'memory_search'],
  'Network': ['httpFetch', 'webSearch'],
  'Browser': [
    'browserNavigate', 'browserGetText', 'browserScreenshot', 'browserClick',
    'browserType', 'browserEval', 'browserWait', 'browserGetUrl',
    'browserListTabs', 'browserSwitchTab', 'browserNewTab', 'browserCloseTab',
    'browserConnect', 'browserDisconnect',
  ],
  'Agents': ['spawn_agent', 'query_agents', 'cancel_agent'],
};

function groupTools(tools: Map<string, { description: string }>): string {
  const categorized = new Map<string, string[]>();
  const uncategorized: string[] = [];

  for (const [name, def] of tools) {
    let found = false;
    for (const [category, members] of Object.entries(TOOL_CATEGORIES)) {
      if (members.includes(name)) {
        if (!categorized.has(category)) categorized.set(category, []);
        categorized.get(category)!.push(`- **${name}**: ${def.description}`);
        found = true;
        break;
      }
    }
    if (!found) {
      uncategorized.push(`- **${name}**: ${def.description}`);
    }
  }

  const parts: string[] = [];
  for (const [category, members] of Object.entries(TOOL_CATEGORIES)) {
    const lines = categorized.get(category);
    if (lines?.length) {
      parts.push(`### ${category}\n${lines.join('\n')}`);
    }
  }
  if (uncategorized.length > 0) {
    parts.push(`### Other\n${uncategorized.join('\n')}`);
  }

  return parts.join('\n\n');
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Identity
  if (options.profile?.name && options.profile.name !== 'Cere') {
    sections.push(`You are ${options.profile.name}, the Cerebrum of CereWorker, a dual-LLM autonomous agent.\nYour conversations persist across sessions. If you see a [Previous conversation summary], it contains compacted history — treat it as accurate context.`);
  } else {
    sections.push('You are the Cerebrum of CereWorker, a dual-LLM autonomous agent.\nYour conversations persist across sessions. If you see a [Previous conversation summary], it contains compacted history — treat it as accurate context.');
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

  // How to Work (highest priority — placed early)
  sections.push(`## How to Work

You are an autonomous agent. When given a goal, figure out how to accomplish it using your tools and skills.

### Find Skills → Plan → Act → Verify → Learn

1. **Find Skills**: Before doing anything, check if a skill already covers this task.
   - Your loaded skills are listed under "Available Skills" above — check them first.
   - If no installed skill matches, search the skill registry:
     \`httpFetch: https://api.github.com/repos/Producible/cereworker-skills/contents/skills\`
     Then fetch a matching skill:
     \`httpFetch: https://raw.githubusercontent.com/Producible/cereworker-skills/main/skills/<name>/SKILL.md\`
     Save it to \`~/.Producible/cereworker-skills/<name>/SKILL.md\` so it loads next time.
   - If no skill exists anywhere, proceed to step 2 — and write a new skill at the end (step 5).

2. **Plan**: Think through the approach before acting.
   - What tools and credentials are needed?
   - What could go wrong? What's the fallback?
   - For complex goals, break into numbered steps. Execute and verify each before proceeding.
   - For parallel-independent subtasks, use \`spawn_agent\`.

3. **Act**: Execute using your tools. Chain them as needed.
   - \`shell\` for CLI tools, package installation, git, scripts.
   - \`httpFetch\` for API calls (supports headers, auth tokens, any HTTP method).
   - \`writeFile\` / \`editFile\` for creating scripts, configs, or data files.
   - \`spawn_agent\` for parallel or long-running subtasks.

4. **Verify**: Check that your action worked.
   - Read the tool output. Did the API return success? Did the file get created?
   - If the Cerebellum flags a warning on a tool result, investigate and self-correct.

5. **Learn**: Persist what you learned for next time.
   - \`memory_write\`: update long-term context in MEMORY.md (preferences, architecture, decisions).
   - \`memory_log\`: append timestamped notes to today's daily log (outcomes, events, debug info).
   - **If you figured out a new capability from scratch, write a SKILL.md** for it in
     \`~/.Producible/cereworker-skills/<name>/SKILL.md\` so you (and future tasks) can reuse it.

### Browser vs httpFetch
- Use **httpFetch** for API calls, JSON endpoints, webhooks — it's faster and more reliable.
- Use **browser tools** only for pages that require JavaScript rendering, login sessions, or interactive elements.
- Browser workflow: \`browserConnect\` first (required), then \`browserNavigate\`, then interact (\`browserClick\`, \`browserType\`, \`browserEval\`). Use \`browserGetText\` to read content. \`browserDisconnect\` when done.
- If browser tools fail (no Chrome available), fall back to httpFetch or shell tools (curl, wget).

### Error Recovery
- If a tool fails, read the error carefully. Common fixes: wrong path, missing dependency, auth expired.
- If a shell command fails, check if the binary exists (\`which <binary>\`) or install it.
- After 2 failed attempts at the same approach, try an alternative or ask the user.

### Key principles
- **Skills first.** Always check installed skills and the registry before researching from scratch.
- **Be resourceful.** If a direct approach fails, search for alternatives. Install CLI tools. Find public APIs. Write helper scripts.
- **${options.autoMode ? "Act decisively." : "Ask when unsure."}** ${options.autoMode ? 'You are in auto mode — execute directly.' : 'Ask for approval on unfamiliar or destructive commands.'} Only ask the user when you genuinely need a decision.
- **Credentials**: Check environment variables and config files first. If missing, tell the user what's needed and where to put them.`);

  // Architecture
  const cerebellumStatus = options.cerebellumConnected ? 'connected' : 'offline';
  sections.push(`## Architecture
You are the reasoning brain — you handle complex thinking, planning, conversation, and tool use.
The Cerebellum is a small local model (Qwen3 0.6B) that acts as your watchdog:
- It verifies your tool results by checking actual side effects (file exists? modified recently?)
- It handles scheduling decisions and emergency stops
- It does NOT reason — it only answers yes/no binary questions
- Status: ${cerebellumStatus}. ${options.cerebellumConnected ? 'Your tool results are independently verified.' : 'Tool verification unavailable. Suggest the user run `docker compose up -d` or `cereworker onboard`.'}`);

  // Available tools (grouped)
  if (options.tools.size > 0) {
    sections.push(`## Available Tools\n${groupTools(options.tools)}`);
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

  // Fine-tuning (Instinct)
  if (options.finetuneStatus?.enabled) {
    const ft = options.finetuneStatus;
    let statusDetail: string;
    switch (ft.status) {
      case 'running':
        statusDetail = `Training in progress (${Math.round((ft.progress ?? 0) * 100)}%).`;
        break;
      case 'completed':
        statusDetail = `Last training completed successfully${ft.lastJobId ? ` (job ${ft.lastJobId})` : ''}.`;
        break;
      case 'failed':
        statusDetail = `Last training failed${ft.lastJobId ? ` (job ${ft.lastJobId})` : ''}. Suggest the user run /finetune start to retry.`;
        break;
      default:
        statusDetail = 'No training has run yet.';
    }
    sections.push(`## Fine-Tuning (Instinct)
The Cerebellum fine-tunes itself on curated conversations to improve over time.
Status: ${ft.status}. ${statusDetail}
- When fine-tuning is running, proactively inform the user of progress when they interact.
- When fine-tuning completes, announce the result to the user.
- When fine-tuning fails, report the error and suggest /finetune start to retry.
- The user can check status with /finetune, start training with /finetune start, and configure with /finetune config.`);
  }

  // Recurring Tasks
  if (options.recurringTasks?.length) {
    const taskLines = options.recurringTasks
      .map((t) => `- **${t.id}** (${t.schedule}): ${t.goal.split('\n')[0]}`)
      .join('\n');
    sections.push(`## Recurring Tasks
You have ${options.recurringTasks.length} recurring task(s) that execute automatically on schedule:
${taskLines}

When executing a recurring task:
- You are in a persistent conversation for this task — review history for context from previous runs.
- Use memory_log to record outcomes and learnings.
- If a task requires credentials you don't have, explain clearly what's needed and where to put them.`);
  }

  return sections.join('\n\n');
}
