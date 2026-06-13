# Contributing to infer-cmd

Thanks for helping! This is a small, dependency-light TypeScript CLI.

## Dev setup

```sh
npm install
```

## Common commands

```sh
npm run dev -- --help     # run the CLI from source via tsx
npm run build             # bundle to dist/cli.js with tsup
npm test                  # run the vitest suite
npm run test:watch        # watch mode
npm run test:cov          # coverage report
npm run typecheck         # tsc --noEmit
```

## Trying the integration locally

```sh
npm run build
eval "$(node dist/cli.js init zsh)"   # in a throwaway zsh
# run a failing command, then:
node dist/cli.js
```

## Project layout

| Path | Purpose |
|---|---|
| `src/cli.ts` | commander entry point, real I/O wiring |
| `src/flow.ts` | tl;dr / `--detail` orchestration + confirm UI (fully injectable) |
| `src/shell/init.ts` | zsh/bash/fish integration script emitters |
| `src/capture/session.ts` | reads the per-shell capture files |
| `src/redact.ts` | ANSI strip + secret redaction + payload capping |
| `src/config.ts` | `~/.infer.toml` load/generate |
| `src/llm.ts` | OpenAI-compatible client, prompts, JSON parsing |
| `test/` | vitest unit + integration tests |

## Guidelines

- Keep runtime dependencies minimal; prefer Node built-ins.
- Anything sent to an LLM must pass through `redact.ts` first.
- The flow layer takes injected I/O and LLM functions — add tests with fakes,
  never real network calls.
- Run `npm test` and `npm run typecheck` before opening a PR.

## Pull requests

PRs run CI on Node 18/20/22 (Linux) and Node 20 (macOS). Keep changes focused
and include tests for new behavior.
