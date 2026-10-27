# Contributing to open-context-mode

This project is licensed under the Elastic License 2.0 (ELv2) and moves forward with your support. Every issue, every PR, every idea matters.

Don't overthink it. Don't ask yourself "is my PR good enough?" or "is this issue too small?" -- just send it. A rough draft beats a perfect plan that never ships. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR.

That said, I'm a solo maintainer with limited time. The best way to help me help you: follow the templates, run the debug script (`bash scripts/open_ctx-debug.sh`), and write tests for your changes. The more context you give me, the faster I can review.

I genuinely love open source and I'm grateful to have you here. Don't hesitate to reach out -- whether it's a question, a suggestion, or just to say hi. Let's build this together.

---

This guide covers the local development workflow so you can test changes in a live OpenCode session before submitting a PR.

## Architecture Overview

open-context-mode uses a flat `src/` structure:

```
src/
  server.ts        → MCP server, tool handlers, auto-indexing
  store.ts         → FTS5 content store (index, search, chunking)
  executor.ts      → Polyglot code executor (12 languages)
  security.ts      → Permission enforcement (deny/allow rules)
  runtime.ts       → Runtime detection (Node, Bun, Python, etc.)
  db-base.ts       → SQLite base class (shared by store + session)
  truncate.ts      → Smart output truncation
  cli.ts           → CLI commands (setup, doctor)
  types.ts         → Shared type definitions
  session/
    db.ts          → SessionDB — persistent event storage
    extract.ts     → Event extractors for PostToolUse hook
    snapshot.ts    → Resume snapshot builder (priority tiers)
  platforms/
    types.ts       → HookAdapter interface, RoutingInstructionsConfig
    detect.ts      → Platform detection via env vars
    opencode/       -> the OpenCode plugin (index.ts, hooks.ts, plugin.ts)
    shared/paths.ts -> tilde-aware path resolution
  base.ts          -> storage-dir resolution shared by the adapter





hooks/core/        -> Plain JS shared by the bundled hooks (routing, tool naming, formatters)
configs/opencode/  -> Install files for the one platform (plugins/opencode-context-mode.ts, AGENTS.md)
hooks/               → Plain JS hooks (.mjs) — no build needed
configs/             → Per-platform install files (settings.json, mcp.json, CLAUDE.md, etc.)
```

`tsc` compiles `src/` → `build/`. `start.mjs` loads `server.bundle.mjs` (CI-built) if present, otherwise falls back to `build/server.js`.

> **Critical for local dev:** Delete `server.bundle.mjs` in your local clone or your `build/server.js` changes will never be loaded:
> ```bash
> rm server.bundle.mjs  # forces start.mjs to use build/server.js
> ```

### Session Continuity Architecture

Session events flow through a two-database system:

1. **SessionDB** (persistent, per-project): `~/.claude/open-context-mode/sessions/<hash>.db`
   - PostToolUse hook captures events in real-time
   - PreCompact hook builds resume snapshots
   - UserPromptSubmit hook captures user prompts

2. **ContentStore** (ephemeral, per-process): `/tmp/open-context-mode-<PID>.db`
   - FTS5 full-text search index for tool outputs
   - Auto-indexes session events file written by SessionStart hook
   - Dies when MCP server process exits

**Session restore flow** (compact/resume):
```
SessionStart hook → reads SessionDB → writes events as markdown file
                  → injects ~275 token directive (summary + search queries)
MCP server        → detects markdown file on next getStore() call
                  → auto-indexes into FTS5 → deletes file
LLM               → searches source:"session-events" for details on demand
```

Raw session events are **never injected into context**. Only a compact summary table + search queries are injected. The LLM searches for details via the existing `open_ctx_search()` MCP tool.

### Multi-writer contract (v1.0.130 — see [docs/adr/0001-sessiondb-multi-writer.md](docs/adr/0001-sessiondb-multi-writer.md))

Both SessionDB and ContentStore are **multi-writer-safe**. Two processes may open the same on-disk dbPath simultaneously — that is the legitimate multi-window UX shape. Write contention is handled by `withRetry()` on top of SQLite's built-in `busy_timeout` (30000ms). Do NOT add `acquireDbLock`-style file locks or `locking_mode = EXCLUSIVE` pragmas to the shared open seam (`openSQLite()` in `src/db-base.ts`, the former `SQLiteBase` ctor) or `applyWALPragmas`. Process-identity invariants (one MCP per project) live in `src/util/sibling-mcp.ts`, not the DB layer.

## Prerequisites

- [OpenCode](https://opencode.ai/) 2.0 or newer
- Node.js 20+ or [Bun](https://bun.sh/) (recommended for speed)
- open-context-mode plugin installed via marketplace

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/mksglu/open-context-mode.git
cd open-context-mode
npm install
npm run build  # tsc compiles src/ → build/
```

### 2. Symlink the cache to your local clone

Point OpenCode at your clone with one plugin file:

First, find your cached version:

```bash
ls ~/.claude/plugins/cache/open-context-mode/open-context-mode/
# Example output: 0.9.23
```

Then replace it with a symlink:

```bash
# Back up the cache (use your actual version number)
mv ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23 \
   ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23.bak

# Symlink to your local clone
ln -s /path/to/your/clone/open-context-mode \
   ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23
```

Replace `/path/to/your/clone/open-context-mode` with your actual local path.

> **Why symlink?** The plugin system overwrites `installed_plugins.json` on every session start, reverting any manual path changes. A symlink lets the plugin system keep its managed path while the actual code resolves to your local clone.

> **Critical:** The symlink must point to the root of your clone (where `hooks/`, `build/`, and `src/` all live). Hooks registered in `hooks.json` use `${CLAUDE_PLUGIN_ROOT}` which resolves to this directory.

### 3. Update PreToolUse hook in settings

The symlink in step 2 ensures `hooks.json` (which registers PostToolUse, PreCompact, SessionStart, and UserPromptSubmit) resolves to your local clone via the plugin system. You only need to override PreToolUse in `~/.claude/settings.json` since its broader matcher is needed for dev mode:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|WebFetch|Agent|mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute|mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute_file|mcp__plugin_open-context-mode_open-context-mode__open_ctx_batch_execute|mcp__(?!plugin_open-context-mode_)",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/your/clone/open-context-mode/hooks/pretooluse.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/your/clone/open-context-mode` with your actual local path.

> **Important:** Do NOT add PostToolUse, PreCompact, SessionStart, or UserPromptSubmit to `settings.json` — they are already registered in `hooks.json` and the symlink makes them resolve to your local clone. Adding them to both causes double invocations, split session IDs, and SQLite locking errors.

### 4. Bump the version for verification

Change the version in your local clone to something recognizable:

```bash
# All 4 files must be updated:
# 1. package.json:              "version": "0.9.23-dev"
# 2. src/server.ts:             const VERSION = "0.9.23-dev";
# 3. .claude-plugin/plugin.json:     "version": "0.9.23-dev"
# 4. .claude-plugin/marketplace.json: "version": "0.9.23-dev"
```

Then rebuild:

```bash
npm run build
```

### 5. Kill cached MCP processes and restart

```bash
# Kill any running open-context-mode processes
pkill -f "open-context-mode.*start.mjs"

# Verify no processes remain
ps aux | grep open-context-mode | grep -v grep
# Should return nothing
```

Restart OpenCode (`opencode service restart`).

### 6. Verify local dev mode

Run `npx open-context-mode doctor`. You should see your dev version:

```
npm (MCP): WARN — local v0.9.23-dev, latest v0.9.23
```

The version warning is expected -- it confirms you're running from your local clone, not the cache.

### Restoring marketplace version

To switch back to the marketplace version:

```bash
# Remove symlink and restore backup
rm ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23
mv ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23.bak \
   ~/.claude/plugins/cache/open-context-mode/open-context-mode/0.9.23
```

Delete `~/.config/opencode/plugins/opencode-context-mode.ts` and restart OpenCode.

## Development Workflow

### Build and test your changes

```bash
# TypeScript compilation
npm run build

# Run all tests (parallel via Vitest)
npm test

# Type checking only
npm run typecheck

# Lint (0 errors required; warnings = tracked debt)
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Format all files (Prettier)
npm run format

# Check formatting without writing
npm run format:check

# Watch mode
npm run test:watch
```

### What needs rebuild?

| Changed | Rebuild needed? | Why |
|---------|:-:|---|
| `hooks/*.mjs` | No | Plain JS, loaded fresh each invocation |
| `src/*.ts` | Yes | Compiles to `build/` (MCP server, executor, store) |
| `src/session/*.ts` | Yes | Compiles to `build/session/`, imported by hooks |
| `src/platforms/**/*.ts` | Yes | Compiles to `build/platforms/`, the plugin entry point |
| `configs/*` | No | Static files, served directly |

After rebuilding, restart your OpenCode session. The MCP server reloads on session start.

> **Tip:** Changed only `hooks/core/*.mjs`? Plain JS, loaded fresh on every invocation - skip the rebuild.

### Key files to know

| File | Purpose |
|---|---|
| `src/server.ts` | MCP server, tool handlers, auto-indexing of session events |
| `src/store.ts` | FTS5 content store (index, search, chunking) |
| `src/executor.ts` | Polyglot code executor (JS, Python, Shell, etc.) |
| `src/session/db.ts` | SessionDB — persistent session event storage |
| `src/session/extract.ts` | Event extractors for PostToolUse hook |
| `src/platforms/detect.ts` | Which client is talking, and its label for the `platform` column |
| `src/platforms/types.ts` | HookAdapter interface, shared platform types |
| `src/platforms/opencode/plugin.ts` | The OpenCode plugin: hooks, tool wiring |
| `hooks/posttooluse.mjs` | Real-time event capture from tool calls |
| `hooks/precompact.mjs` | Resume snapshot builder (fires before compact) |
| `hooks/pretooluse.mjs` | Tool routing + context window protection |
| `hooks/session-helpers.mjs` | Shared utilities (stdin reader, session ID, DB paths) |

## TDD Workflow

We follow test-driven development. Every PR must include tests.

**We strongly recommend installing the open-context-mode-ops skill** — it includes TDD enforcement, issue triage, PR review, and release automation with parallel subagent orchestration.

The skill lives under `.claude/skills/open-context-mode-ops/` in this repo (moved from the deprecated `skills/` location in #439). Install via the direct path:

```bash
npx skills add https://github.com/mksglu/open-context-mode/tree/main/.claude/skills/open-context-mode-ops
```

### Red-Green-Refactor

1. **Red** -- Write a failing test for the behavior you want
2. **Green** -- Write the minimum code to make it pass
3. **Refactor** -- Clean up while keeping tests green

### Test file organization

**Do NOT create new test files.** Add your tests to the existing file that covers the same domain. We maintain a small number of well-organized test files — one per adapter, one per core module. Creating a new file per feature or per PR leads to fragmentation that makes the suite harder to navigate and maintain.

| Domain | Test File |
|---|---|
| Platform | `tests/adapters/opencode.test.ts` |
| Client detection | `tests/adapters/detect.test.ts` |
| Search & FTS5 | `tests/core/search.test.ts` |
| Server & tools | `tests/core/server.test.ts` |
| CLI & bundle | `tests/core/cli.test.ts` |
| Routing | `tests/core/routing.test.ts` |
| Hook routing | `tests/hooks/core-routing.test.ts` |
| Hook tool naming | `tests/hooks/tool-naming.test.ts` |
2. Run it **again** with your change
3. Include both outputs in your PR


## Prose-style policy (issue [#482](https://github.com/mksglu/open-context-mode/issues/482))

open-context-mode does not dictate how the model writes its final answer. The four pillars (sandbox routing, session continuity, think-in-code, no prose-style enforcement) keep raw data out of context but leave editorial style — brevity vs. completeness, formatting, tone — entirely to the model and the user's own `CLAUDE.md` / `AGENTS.md`.

**Why:** aggressive brevity instructions have been shown to degrade coding/reasoning benchmarks. Moonshot AI's report on `kimi-k2.5` (cited in [#482](https://github.com/mksglu/open-context-mode/issues/482), with the OpenCode fix at [anomalyco/opencode#20259](https://github.com/anomalyco/opencode/pull/20259)) showed that prompts like "minimize output tokens", "MUST answer concisely with fewer than 4 lines", and "one-word answers are best" pushed coding models to drop assumptions, caveats, verification evidence, failure modes, and security warnings the user actually needed.

**What this means for contributors:**

- Do **not** add brevity directives to MCP tool descriptions in `src/server.ts`.
- Do **not** add `<communication_style>` or `<response_format>` blocks to `hooks/routing-block.mjs`.
- Do **not** put "Terse like caveman" / "Only fluff die" / "Drop articles, filler" / "fewer than N lines" wording in any shipped adapter config under `configs/*/`.
- Workflow-discipline rules — "write artifacts to FILES", "use descriptive `open_ctx_search` source labels", `<artifact_policy>` — are fine. They describe *what to do* (file vs. inline), not *how to write*.

The regression test at `tests/core/server.test.ts > prose-style policy (#482)` pins the deletion: any caveman-style language landing in `src/server.ts`, `hooks/routing-block.mjs`, or `README.md` will fail CI.

If you genuinely need to nudge the model on style for a specific use case, do it in your own project's `CLAUDE.md` / `AGENTS.md`. Don't ship it inside the framework.

## For Pi developers

open-context-mode works on Pi now. The extension injects routing rules, registers
open_ctx_* tools through the MCP bridge, and the lean `configs/pi/AGENTS.md` keeps
context budget tight.

**First-time setup:** If you open this project in Pi before running `npm install`
and `npm run build`, you will see errors. That's normal — the extension needs
the compiled server bundle. Run the build once and restart.

- If you use Pi: remove `CLAUDE.md` from your project root. Pi.dev reads both
  CLAUDE.md and AGENTS.md, burning double context on duplicated routing
  instructions the extension already injects.
- Use `open_ctx_search` to recall decisions, errors, and blockers from prior
  sessions instead of re-reading raw files.
- Use `open_ctx_insight` for personal analytics — session activity, tool usage,
  error rate, project focus.

For the full local dev workflow, build commands, and test instructions, see
[the contributing guide above](#contributing-to-open-context-mode).

## Submitting a Bug Report

When filing a bug, **always include your prompt**. The exact message you sent to the agent is critical for reproduction. Without it, we can't debug the issue.

Required information:
- Debug script output: `bash scripts/open_ctx-debug.sh` (collects OS, runtimes, configs, hooks, SQLite diagnostics)
- The prompt that triggered the bug
- Full error output (expand with `Ctrl+O` in OpenCode)
- Steps to reproduce

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch from `next`
3. Follow the local development setup above
4. Write tests first (TDD)
5. Run `npm test` and `npm run typecheck`
6. Test in a live OpenCode session
7. Compare output quality before/after
8. Open a PR using the template

## Quick Reference

| Task | Command |
|---|---|
| Check version | `/open-context-mode:open-ctx-doctor` |
| View session stats | `/open-context-mode:open-ctx-stats` |
| Purge knowledge base | `/open-context-mode:open-ctx-purge` |
| Run diagnostics | `bash scripts/open_ctx-debug.sh` |
| See background steps | `Ctrl+O` |
| Kill cached server | `pkill -f "open-context-mode.*start.mjs"` |
| Rebuild after changes | `npm run build` |
| Run all tests | `npm test` |
| Watch mode | `npm run test:watch` |
