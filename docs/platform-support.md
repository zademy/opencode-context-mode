# Platform support

Two shapes, one package.

## OpenCode — the platform

open-context-mode ships a plugin. OpenCode loads it and the `open_ctx_*` tools are
registered in-process — there is no MCP subprocess, no `npx`, and no config
file to hand-edit.

```bash
npx open-context-mode mcp   # prints the block below if you prefer wiring it by hand
```

The plugin registers the tools. Do **not** also add an `mcp.open-context-mode`
entry for OpenCode: the loader would register zero tools.

Onboarding is one file, `~/.config/opencode/plugins/open-context-mode.ts`:

```ts
export { default } from "open-context-mode/build/platforms/opencode/plugin.js";
```

A filesystem path in the `plugin` key of `opencode.json` is silently ignored
by OpenCode 2.0.22+ — that is why it is a plugin file and not a config entry.

See [`configs/opencode/`](../configs/opencode/) for the shipped copy and
[`tests/adapters/opencode.test.ts`](../tests/adapters/opencode.test.ts) for
the behaviour it pins.

## Every other agent — MCP only

Anything that speaks the Model Context Protocol gets the same server over
stdio. One config block:

```json
{
  "mcpServers": {
    "open-context-mode": { "command": "npx", "args": ["-y", "open-context-mode"] }
  }
}
```

`open-context-mode mcp` prints exactly that. Copy it into your client's MCP config.

### What an MCP client gets

- All 11 `open_ctx_*` tools, including sandboxed `open_ctx_execute`.
- The SQLite knowledge base and the session history under
  `~/.config/opencode/open-context-mode/`.

### What an MCP client does not get

The parts that need a host hook, because MCP has no equivalent:

- **Auto-injection.** Nothing rewrites the tool descriptions before the model
  reads them, so the token saving comes from what the model asks for, not
  from a prompt prefix.
- **Session attribution.** The `platform` column records the sanitized
  `clientInfo.name` instead of a host-specific session id, and per-tool
  `usage` accounting does not run. `open_ctx_stats` still reports lifetime
  numbers; it cannot report a tool-by-tool split for those sessions.
- **Auto-memory writes on compaction.** The continuity snapshot that rescues
  bytes after a compaction is written by an OpenCode hook.

## Storage

One tree, whoever asks: `~/.config/opencode/open-context-mode/{sessions,content,stats}`
(honouring `XDG_CONFIG_HOME`, and `OPEN_CONTEXT_MODE_DATA_DIR` to relocate it).
Context-mode does not look anywhere else, and no other client has a
directory of its own.

Data written by older versions under `~/.claude/open-context-mode/` or
`~/.gemini/open-context-mode/` is no longer scanned. Point `OPEN_CONTEXT_MODE_DATA_DIR`
at it if you want to keep reading it.

## SQLite Backend Selection

open-context-mode picks a backend at runtime. No configuration.

| Priority | Condition | Backend | Why |
|---|---|---|---|
| 1 | Bun runtime | `bun:sqlite` | Built in, no native addon |
| 2 | Linux + Node.js >= 22.5 | `node:sqlite` | Built in, avoids the [SIGSEGV from V8's madvise bug](https://github.com/nodejs/node/issues/62515) |
| 3 | Anything else | `better-sqlite3` | Mature native addon, prebuilt binaries |

**Why `node:sqlite` on Linux.** Node's V8 garbage collector can call
`madvise(MADV_DONTNEED)` on memory that overlaps `better-sqlite3`'s
`.got.plt`, corrupting resolved symbols and causing sporadic SIGSEGVs
(1-4/hour on Node 22-24). `node:sqlite` is compiled into the Node binary:
no `.node` file, no `dlopen()`, nothing to corrupt.

Below 22.5 it falls back to `better-sqlite3` silently.