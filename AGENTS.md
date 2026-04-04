# Repository Guidelines

## Project Structure & Module Organization
This is a pnpm/turbo monorepo. User-facing entry points live in `apps/`, mainly `apps/cli`. Shared TypeScript packages live in `packages/` (`core`, `browser`, `cerebrum`, `cerebellum-client`, `config`, etc.). The Python Cerebellum service is in `cerebellum/src`, with tests in `cerebellum/tests`. Protocol buffers are defined in `proto/`. Supporting scripts and operational assets live in `scripts/`, `assets/`, and `systemd/`.

## Build, Test, and Development Commands
- `pnpm build`: build the full workspace with Turbo.
- `pnpm dev`: run package-local dev pipelines where available.
- `pnpm typecheck`: run TypeScript checks across the repo.
- `pnpm lint`: run ESLint.
- `pnpm test`: run the Vitest suite.
- `pnpm test:unit`: run unit tests only.
- `pnpm test:e2e:integration`: run the CLI service integration test.
- `pnpm --filter @cereworker/cli start`: start the CLI directly.

Use package filters for focused work, for example `pnpm --filter @cereworker/core build`.

## Coding Style & Naming Conventions
Use existing ESM TypeScript patterns and keep changes small and local. Follow Prettier and ESLint config in the repo (`.prettierrc`, `eslint.config.js`). Match current file naming:
- React components: `PascalCase.tsx`
- most modules and utilities: `kebab-case.ts`
- exported types/interfaces: `PascalCase`
- variables/functions: `camelCase`

Prefer short, explicit functions and structured logs over ad hoc `console.log` debugging.

## Testing Guidelines
Vitest is the main TS test runner; coverage uses the V8 provider and emits `text` and `lcov`. Test files should live beside source as `*.test.ts` or `*.test.tsx` under `packages/*/src` and `apps/*/src`. Add focused regression tests for orchestration, retry, and browser-tool behavior when fixing bugs. For Python changes under `cerebellum/`, add or update tests in `cerebellum/tests`.

## Commit & Pull Request Guidelines
Use short, imperative commit subjects like `Add Cerebellum recovery guidance for retries`. Release commits may use the existing versioned style, for example `v26.330.2: Browser progress ledger + task checkpoints`. Every commit pushed to GitHub must also include a meaningful description/body, not just the subject line. Do not add `Co-Authored-By` trailers to commits. PRs should explain the user-visible change, note risky areas, list validation commands, and include screenshots or terminal captures for CLI/TUI changes.

## Configuration & Security Tips
Do not commit secrets, tokens, or local config. Browser relay, model, and profile settings are environment-specific; validate them locally before testing browser flows. When debugging retries or tool behavior, prefer `--debug` and structured logs instead of printing sensitive raw state into normal user output.
