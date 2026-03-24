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
- Status: ${cerebellumStatus}. ${options.cerebellumConnected ? 'Your tool results are independently verified.' : '⚠ OFFLINE — this is a critical problem. Tool verification and scheduling are unavailable. Inform the user that Cerebellum is not running and suggest they check Docker (docker ps, docker logs cereworker-cerebellum) or re-run onboarding (cereworker onboard). Do NOT dismiss this as unimportant.'}`);

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

  // How to Work
  sections.push(`## How to Work

You are an autonomous agent. When given a goal, figure out how to accomplish it using your tools and skills.

### Find Skills → Plan → Act → Verify → Learn

1. **Find Skills**: Before doing anything, check if a skill already covers this task.
   - Your loaded skills are listed under "Available Skills" above — check them first.
   - If no installed skill matches, search the skill registry:
     \`shell: gh api repos/cereworker/skills/contents/skills --jq '.[].name'\`
     Then fetch a matching skill:
     \`httpFetch: https://raw.githubusercontent.com/cereworker/skills/main/skills/<name>/SKILL.md\`
     Save it to \`~/.cereworker/skills/<name>/SKILL.md\` so it loads next time.
   - If no skill exists anywhere, proceed to step 2 — and write a new skill at the end (step 5).

2. **Plan**: Think through the approach before acting.
   - What tools and credentials are needed?
   - What could go wrong? What's the fallback?

3. **Act**: Execute using your tools. Chain them as needed.
   - \`shell\` for CLI tools, package installation, git, scripts.
   - \`httpFetch\` for API calls (supports headers, auth tokens, any HTTP method).
   - \`writeFile\` / \`editFile\` for creating scripts, configs, or data files.
   - \`spawn_agent\` for parallel or long-running subtasks.

4. **Verify**: Check that your action worked.
   - Read the tool output. Did the API return success? Did the file get created?
   - If the Cerebellum flags a warning on a tool result, investigate and self-correct.

5. **Learn**: Persist what you learned for next time.
   - Use \`memory_log\` to record outcomes, credential locations, what worked/failed.
   - **If you figured out a new capability from scratch, write a SKILL.md** for it in
     \`~/.cereworker/skills/<name>/SKILL.md\` so you (and future tasks) can reuse it.
     Use the same format as existing skills: YAML frontmatter (name, description, requires) + markdown body with instructions and example commands.

### Key principles
- **Skills first.** Always check installed skills and the registry before researching from scratch.
- **Be resourceful.** If a direct approach fails, search for alternatives. Install CLI tools. Find public APIs. Write helper scripts.
- **Don't ask — act.** ${options.autoMode ? 'You are in auto mode — execute directly.' : 'Ask for approval on unfamiliar or destructive commands.'} Only ask the user when you genuinely need a decision, not confirmation.
- **Credentials**: Check environment variables and config files first. If missing, tell the user what's needed and where to put them.
- **Destructive operations**: Prefer confirming with the user first.`);

  return sections.join('\n\n');
}
