<p align="center">
  <img src="assets/logo.png" alt="CereWorker" width="300" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cereworker/cli"><img src="https://img.shields.io/npm/v/@cereworker/cli" alt="npm" /></a>
  <a href="https://github.com/Producible/CereWorker/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Producible/CereWorker" alt="GitHub" /></a>
</p>

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
                    +--+-+---+---+-+--+
                       | |   |   | |
        +--------------+ |   |   | +--------------+
        |          +-----+   |   +------+         |
        |          |         |          |         |
+-------+---+ +---+------+  |  +-------+--+ +----+--------+
| Cerebrum  | | Cerebellum|  |  | Hippo-   | | Channels    |
| (AI SDK 6)| | (Docker/  |  |  | campus   | | Slack,      |
| Claude,   | |  gRPC)    |  |  | (Memory) | | Discord,    |
| GPT,      | | Heartbeat |  |  | MEMORY.md| | Telegram,   |
| Gemini,   | | Fine-tune |  |  | Daily    | | Matrix,     |
| local     | | Instinct  |  |  | logs     | | Feishu,     |
+-----------+ +-----------+  |  +----------+ | WeChat      |
                              |               +-------------+
                     +--------+--------+
                     | Browser/Skills  |
                     | Puppeteer, SKILL|
                     +-----------------+
```

The **Orchestrator** sits at the center. It routes user messages to the Cerebrum, executes tool calls, streams responses to the TUI, and listens to heartbeat events from the Cerebellum. It emits typed events (`message:cerebrum:chunk`, `tool:start`, `heartbeat:tick`, etc.) that the UI and other components subscribe to.

The **Cerebrum** wraps Vercel AI SDK 6 to provide a unified interface across providers. Switching from Claude to GPT to Gemini to a local Ollama model is a config change. The Cerebrum also owns the tool registry -- shell execution, file operations, browser automation, and memory tools are all registered as AI SDK tools that the LLM can call during multi-step reasoning.

The **Cerebellum** runs as a Python gRPC service inside a Docker container with a configurable small LLM (Qwen3 0.6B/1.7B, SmolLM2, Phi-4 Mini, or a custom model). The TypeScript side communicates with it via streaming RPCs defined in `proto/cerebellum.proto`. The container manages its own model weights and supports fine-tuning via LoRA, QLoRA, or full methods on a configurable schedule. After fine-tuning, the container can be hot-swapped with updated weights without interrupting the main process.

The **Hippocampus** is CereWorker's temporary memory layer, inspired by the brain structure that consolidates short-term memory into long-term storage. It stores session notes, decisions, and observations in `~/.cereworker/memory/` as markdown files (`MEMORY.md` for curated knowledge, `YYYY-MM-DD.md` for daily logs). The Cerebrum reads and writes to the Hippocampus during normal conversation via memory tools. Periodically, a curator process reviews the Hippocampus and selects memories worth permanently learning -- these are extracted as training pairs and fed into the Cerebellum's fine-tuning pipeline. This is how ephemeral context becomes permanent knowledge without consuming context window.

**Channels** are pluggable IM adapters. Each implements a simple interface: `start(handler)`, `stop()`, `send(msg)`, `isAllowed(senderId)`. The channel manager starts all enabled channels and routes inbound messages through the orchestrator, so the agent can be reached via Slack, Discord, Telegram, Matrix, Feishu, or WeChat simultaneously.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for Cerebellum)

### Install from npm

```bash
npm install -g @cereworker/cli
```

### Setup

The easiest way to get started is the interactive onboarding wizard:

```bash
cereworker onboard
```

The wizard walks you through:
- **LLM provider** -- Anthropic, OpenAI, Google, or local (Ollama/vLLM)
- **Cerebellum model** -- choose from Qwen3, SmolLM2, Phi-4 Mini, or a custom checkpoint, with hardware-aware recommendations
- **Fine-tuning** -- method (Auto/LoRA/QLoRA/Full) and schedule, with GPU/RAM detection
- **Messaging channels** -- enable Slack, Discord, Telegram, Matrix, Feishu, or WeChat
- **Config output** -- writes `~/.cereworker/config.yaml` with env var references for secrets

After onboarding, start the agent:

```bash
cereworker
```

Or configure manually:

```bash
mkdir -p ~/.cereworker
cat > ~/.cereworker/config.yaml << 'EOF'
cerebrum:
  defaultProvider: anthropic
  defaultModel: claude-sonnet-4-6
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
EOF

ANTHROPIC_API_KEY=sk-... cereworker
```

### From source

```bash
git clone https://github.com/Producible/CereWorker.git
cd CereWorker
pnpm install
pnpm build
pnpm start
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

| Package | npm | Description |
|---------|-----|-------------|
| [`@cereworker/cli`](apps/cli) | [![npm](https://img.shields.io/npm/v/@cereworker/cli)](https://www.npmjs.com/package/@cereworker/cli) | Ink 5 terminal UI |
| [`@cereworker/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@cereworker/core)](https://www.npmjs.com/package/@cereworker/core) | Orchestrator, message model, typed events, conversation store |
| [`@cereworker/cerebrum`](packages/cerebrum) | [![npm](https://img.shields.io/npm/v/@cereworker/cerebrum)](https://www.npmjs.com/package/@cereworker/cerebrum) | AI SDK 6 multi-provider LLM abstraction + built-in tools |
| [`@cereworker/cerebellum-client`](packages/cerebellum-client) | [![npm](https://img.shields.io/npm/v/@cereworker/cerebellum-client)](https://www.npmjs.com/package/@cereworker/cerebellum-client) | gRPC client for the Cerebellum container |
| [`@cereworker/channels`](packages/channels) | [![npm](https://img.shields.io/npm/v/@cereworker/channels)](https://www.npmjs.com/package/@cereworker/channels) | IM adapters (Slack, Discord, Telegram, Matrix, Feishu, WeChat) |
| [`@cereworker/browser`](packages/browser) | [![npm](https://img.shields.io/npm/v/@cereworker/browser)](https://www.npmjs.com/package/@cereworker/browser) | Puppeteer browser automation tools |
| [`@cereworker/skills`](packages/skills) | [![npm](https://img.shields.io/npm/v/@cereworker/skills)](https://www.npmjs.com/package/@cereworker/skills) | SKILL.md plugin loader and registry |
| [`@cereworker/hippocampus`](packages/hippocampus) | [![npm](https://img.shields.io/npm/v/@cereworker/hippocampus)](https://www.npmjs.com/package/@cereworker/hippocampus) | Temporary memory store, memory tools, fine-tune curator |
| [`@cereworker/config`](packages/config) | [![npm](https://img.shields.io/npm/v/@cereworker/config)](https://www.npmjs.com/package/@cereworker/config) | YAML config with Zod validation, env var interpolation |

## Built-in Tools

**Shell & File Operations** -- Execute commands, read/write files, list directories

**Browser Automation** -- Navigate, screenshot, click, type, evaluate JS, wait for elements

**Memory (Hippocampus)** -- Read/write MEMORY.md, append daily logs, search across memory files

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

## Cerebellum Models

The Cerebellum supports multiple small LLMs, selectable during onboarding or via config:

| Model | HuggingFace ID | Size | Min RAM | Best for |
|-------|---------------|------|---------|----------|
| Qwen3 0.6B | `Qwen/Qwen3-0.6B` | ~1.2 GB | 2 GB | CPU-only, low-memory systems |
| Qwen3 1.7B | `Qwen/Qwen3-1.7B` | ~3.4 GB | 4 GB | CPU with 8+ GB RAM |
| SmolLM2 360M | `HuggingFaceTB/SmolLM2-360M-Instruct` | ~720 MB | 1.5 GB | Ultra-lightweight, fastest |
| SmolLM2 1.7B | `HuggingFaceTB/SmolLM2-1.7B-Instruct` | ~3.4 GB | 4 GB | Good balance of speed and quality |
| Phi-4 Mini 3.8B | `microsoft/Phi-4-mini-instruct` | ~7.6 GB | 8 GB | GPU recommended, best quality |
| Custom | local path | varies | varies | Your own fine-tuned checkpoint |

Fine-tuning methods: **Auto** (detects your hardware), **LoRA** (GPU 4+ GB VRAM), **QLoRA** (GPU 2+ GB VRAM), **Full** (16+ GB RAM or 8+ GB VRAM). Schedule: Auto (idle time), Hourly, Daily, or Weekly.

## Hippocampus: Memory System

The Hippocampus is CereWorker's temporary memory layer that bridges conversations and fine-tuning:

```
~/.cereworker/memory/
  MEMORY.md              # Curated long-term notes (always loaded)
  2026-03-08.md           # Today's session log
  2026-03-07.md           # Yesterday's log
  finetune/
    pending.jsonl         # Training pairs awaiting fine-tune
    consumed/             # Archived after fine-tuning
```

The Cerebrum reads and writes memory through four tools: `memory_read`, `memory_write`, `memory_log`, and `memory_search`. Periodically, a **curator** reviews the Hippocampus and asks the Cerebrum: "Which of these memories contain durable knowledge worth permanently learning?" The answer is extracted as instruction/response training pairs and queued for the Cerebellum's fine-tuning pipeline.

This creates a natural flow: conversation --> Hippocampus (files) --> curation (Cerebrum) --> fine-tuning (Cerebellum) --> permanent knowledge (model weights).

## Configuration

Config is loaded with cascading precedence:

1. Built-in defaults
2. `~/.cereworker/config.yaml` (global)
3. `./.cereworker.yaml` (project-local)
4. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
5. CLI flags

Full config example:

```yaml
cerebrum:
  defaultProvider: anthropic
  defaultModel: claude-sonnet-4-6
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}

cerebellum:
  enabled: true
  model:
    source: huggingface
    id: Qwen/Qwen3-0.6B
  finetune:
    enabled: true
    method: auto       # auto | lora | qlora | full
    schedule: auto     # auto | hourly | daily | weekly
  docker:
    autoStart: true

hippocampus:
  enabled: true
  directory: ~/.cereworker/memory
  maxDailyLogDays: 30
  autoLog: true

channels:
  telegram:
    enabled: true
    token: ${TELEGRAM_BOT_TOKEN}
```

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
