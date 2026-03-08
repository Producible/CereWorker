# CereWorker

A dual-LLM autonomous agent that pairs a small local model (the **Cerebellum**) with giant cloud LLMs (the **Cerebrum**) to produce work that is not just intelligent, but verifiably effective in the real world.

## Why CereWorker

Most AI agents today are built on a single giant LLM. They reason well, but they have critical blind spots:

- **They forget.** Context windows are finite. Prompt-engineered memory (like injecting past summaries) is fragile and degrades over time. The agent loses track of what it learned three conversations ago.
- **They lie about their work.** A giant LLM can confidently report "I wrote the file" or "I sent the request" without the action actually succeeding. There is no independent verification layer.
- **They run on external schedules.** Cron jobs and timers are rigid. They don't understand "check this when the system seems idle" or "run this more frequently when things are failing." The scheduling has no intelligence.

CereWorker solves these problems by splitting the agent into two cooperating brains, modeled after the human nervous system:

- The **Cerebrum** (giant LLM) handles complex reasoning, planning, conversation, and tool use. It is the thinker.
- The **Cerebellum** (small local LLM, Qwen3 0.6B in Docker) handles coordination, verification, and persistent memory. It is the doer's watchdog.

This isn't just an architectural novelty. The Cerebellum provides three concrete capabilities that no prompt engineering can replicate:

### 1. Heartbeat: Intelligent Scheduling

Instead of cron expressions, tasks are registered with natural language hints like "check every few minutes" or "run when the user seems idle." The Cerebellum evaluates all pending tasks each tick and decides what to invoke, skip, or defer based on current system state. The schedule has judgment.

### 2. Muscle+Skeleton: Work Verification

When the Cerebrum says it wrote a file, the Cerebellum checks the disk. When it says it made an API call, the Cerebellum checks network traffic. The Cerebrum thinks; the Cerebellum verifies what actually happened. This closes the gap between "the LLM said it did something" and "something was actually done."

### 3. Instinct: Persistent Memory via Fine-Tuning

Instead of simulating memory through prompt injection (which is lossy and context-limited), the Cerebellum periodically fine-tunes itself on conversations between the user and the agent. Knowledge is burned into model parameters, not pasted into prompts. The fine-tuning happens automatically during idle time: the Cerebellum copies itself, trains on accumulated conversations, and hot-swaps the container with updated weights. The agent genuinely learns, and that learning survives across sessions without consuming context window.

### The Result

An agent that schedules its own work intelligently, catches its own mistakes, and builds genuine long-term memory -- not through clever prompting, but through architectural separation of concerns between thinking (Cerebrum) and acting/remembering (Cerebellum).

## Architecture

```
                    +------------------+
                    |   TUI (Ink/CLI)  |
                    +--------+---------+
                             |
                    +--------+---------+
                    |   Orchestrator   |
                    +--+-----+-----+--+
                       |     |     |
          +------------+     |     +------------+
          |                  |                  |
+---------+------+  +--------+--------+  +------+---------+
| Cerebrum       |  | Cerebellum      |  | Channels       |
| (AI SDK 6)     |  | (Docker/gRPC)   |  | Slack, Discord |
| Claude, GPT,   |  | Qwen3 0.6B      |  | Telegram,Matrix|
| Gemini, local  |  | Heartbeat/Mon/  |  | Feishu, WeChat |
+----------------+  | Fine-tune       |  +----------------+
                    +-----------------+
```

The **Orchestrator** sits at the center. It routes user messages to the Cerebrum, executes tool calls, streams responses to the TUI, and listens to heartbeat events from the Cerebellum. It emits typed events (`message:cerebrum:chunk`, `tool:start`, `heartbeat:tick`, etc.) that the UI and other components subscribe to.

The **Cerebrum** wraps Vercel AI SDK 6 to provide a unified interface across providers. Switching from Claude to GPT to Gemini to a local Ollama model is a config change. The Cerebrum also owns the tool registry -- shell execution, file operations, and browser automation are all registered as AI SDK tools that the LLM can call during multi-step reasoning.

The **Cerebellum** runs as a Python gRPC service inside a Docker container. The TypeScript side communicates with it via streaming RPCs defined in `proto/cerebellum.proto`. The container manages its own model weights, and can be hot-swapped after fine-tuning without interrupting the main process.

**Channels** are pluggable IM adapters. Each implements a simple interface: `start(handler)`, `stop()`, `send(msg)`, `isAllowed(senderId)`. The channel manager starts all enabled channels and routes inbound messages through the orchestrator, so the agent can be reached via Slack, Discord, Telegram, Matrix, Feishu, or WeChat simultaneously.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for Cerebellum)

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Create config with your API key
mkdir -p ~/.cereworker
cat > ~/.cereworker/config.yaml << 'EOF'
cerebrum:
  defaultProvider: anthropic
  defaultModel: claude-sonnet-4-6
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
EOF

# Run the TUI
ANTHROPIC_API_KEY=sk-... pnpm start
```

### Start the Cerebellum (optional)

```bash
docker compose up -d cerebellum
```

### Enable IM Channels (optional)

Add channel config to `~/.cereworker/config.yaml`:

```yaml
channels:
  slack:
    enabled: true
    botToken: xoxb-...
    appToken: xapp-...
  discord:
    enabled: true
    token: ...
  telegram:
    enabled: true
    token: ...
  matrix:
    enabled: true
    homeserver: https://matrix.org
    token: ...
    userId: "@bot:matrix.org"
  feishu:
    enabled: true
    appId: cli_...
    appSecret: ...
    verificationToken: ...   # optional
    encryptKey: ...           # optional
  wechat:
    enabled: true
    puppet: wechaty-puppet-wechat4u  # or other puppet provider
    token: ...                       # optional, depends on puppet
```

## How It Works

### Message Flow

When you type a message in the TUI:

1. The Orchestrator appends it to the conversation and calls the Cerebrum
2. The Cerebrum streams its response via AI SDK, emitting text chunks to the TUI in real-time
3. If the Cerebrum decides to use a tool (shell, file, browser), the tool executes and the result feeds back into the LLM for the next reasoning step
4. The final response is appended to the conversation
5. Asynchronously, the Cerebellum is notified of the completed turn (for monitoring and future fine-tuning)

### Heartbeat Flow

Running in parallel:

1. The Cerebellum's heartbeat engine ticks every N seconds (configurable, default 30s)
2. It gathers all registered tasks and their current states
3. Qwen3 0.6B evaluates a structured prompt describing the tasks and system state
4. The model outputs a JSON array of decisions: invoke, skip, defer, or cancel each task
5. "Invoke" actions stream back to the TypeScript orchestrator via gRPC server-streaming
6. The orchestrator executes the invoked tasks (which may trigger Cerebrum calls, tool runs, or notifications)

### Channel Flow

When a message arrives from Slack/Discord/Telegram/Matrix/Feishu/WeChat:

1. The channel adapter receives it and checks the sender against the allowlist
2. If allowed, it forwards the message text to the orchestrator
3. The orchestrator processes it the same way as a TUI message (Cerebrum reasoning + tools)
4. The response is sent back through the same channel adapter

### Comparison with Traditional Agents

| Aspect | Traditional (e.g., OpenClaw) | CereWorker |
|--------|------------------------------|------------|
| Memory | Prompt injection, vector DB search | Fine-tuned into Cerebellum parameters |
| Scheduling | Cron expressions, fixed timers | Small LLM evaluates what needs attention |
| Verification | Trust LLM output | Cerebellum monitors actual disk/network effects |
| Context limits | Summarize and hope | Knowledge survives in model weights |
| Cost | Every request hits giant LLM | Routine decisions handled by local 0.6B model |

## Packages

| Package | Description |
|---------|-------------|
| `@cereworker/config` | YAML config with Zod validation, env var interpolation |
| `@cereworker/core` | Orchestrator, message model, typed events, conversation store |
| `@cereworker/cerebrum` | AI SDK 6 multi-provider LLM abstraction + built-in tools |
| `@cereworker/cerebellum-client` | gRPC client for the Cerebellum container |
| `@cereworker/channels` | IM adapters (Slack, Discord, Telegram, Matrix, Feishu, WeChat) |
| `@cereworker/browser` | Puppeteer browser automation tools |
| `@cereworker/skills` | SKILL.md plugin loader and registry |
| `@cereworker/cli` | Ink 5 terminal UI |

## Built-in Tools

**Shell & File Operations** - Execute commands, read/write files, list directories

**Browser Automation** - Navigate, screenshot, click, type, evaluate JS, wait for elements

## Skills

Skills are defined as `SKILL.md` files with YAML frontmatter:

```markdown
---
name: github
description: "GitHub operations via gh CLI"
metadata:
  cereworker:
    requires:
      bins: ["gh"]
---

# GitHub Skill
Use the `gh` CLI to interact with GitHub...
```

Place skills in `~/.cereworker/skills/` or the project's `skills/` directory.

## Configuration

Config is loaded with cascading precedence:

1. Built-in defaults
2. `~/.cereworker/config.yaml` (global)
3. `./.cereworker.yaml` (project-local)
4. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
5. CLI flags

## Development

```bash
pnpm install          # install deps
pnpm build            # build all packages
pnpm typecheck        # type-check without emitting
pnpm dev              # run CLI in dev mode (tsx)
```

## Acknowledgments

CereWorker is built on the shoulders of [OpenClaw](https://github.com/openclaw/openclaw), which pioneered a tangible, open-source form of what AI agents can be -- multi-platform, skill-driven, and genuinely useful in daily work. Its architecture for channels, skills, and autonomous task execution provided the foundation that CereWorker extends with the Cerebellum/Cerebrum dual-LLM approach. Without OpenClaw demonstrating that a personal AI agent could be real and practical, CereWorker would not exist.

## License

MIT
