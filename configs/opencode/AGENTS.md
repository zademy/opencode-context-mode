# open-context-mode — MANDATORY routing rules

**Route** every tool result through a sandbox. Every byte a tool returns enters context and spends reasoning capacity for the rest of the session. One unrouted command dumps 56 KB.

## Think in Code — MANDATORY

Analyze/count/filter/compare/search/parse/transform data: **write code** via `open_ctx_execute(language, code)`, `console.log()` only the answer. PROGRAM the analysis, not COMPUTE it. Default to JavaScript — Node.js built-ins only (`fs`, `path`, `child_process`), `try/catch`, handle `null`/`undefined` — but every supported runtime is fine (`python`, `typescript`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`, `csharp`); pick whichever fits the job. One script replaces ten tool calls.

## Route: denied tools → ctx equivalent

Hooks deny these and answer with a redirect. Follow the redirect; retry the same call only on a transient network error.

| Instead of | Route to |
|---|---|
| `curl` / `wget` | `open_ctx_fetch_and_index(url, source)`, or `open_ctx_execute(language: "javascript", code: "const r = await fetch(...)")` |
| `fetch('http…')`, `requests.get(`, `requests.post(`, `http.get(`, `http.request(` | `open_ctx_execute(language, code)` — only stdout enters context |
| Direct web fetching | `open_ctx_fetch_and_index(url, source)` then `open_ctx_search(queries)` |

Two passthroughs: `curl`/`wget` with `-o`/`-O` (bytes go to a file, not the conversation), and claude.ai / preview.claude.ai artifact URLs (they need your authenticated session).

## Route: flooding tools → sandbox

| Tool | Right for | Route when |
|---|---|---|
| Shell | `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, installs — short fixed output | `open_ctx_batch_execute(commands, queries)`, or `open_ctx_execute(language: "javascript", code: "...")` (use `language: "shell"` only when the code matches the host shell) |
| Read | reading to **edit** | `open_ctx_execute_file(path, language, code)` to analyze, explore, or summarize |
| grep / search | spot-checking one match | `open_ctx_execute(language: "javascript", code: "...")` to count, filter, or aggregate |

## Tool selection

0. **MEMORY**: `open_ctx_search(sort: "timeline")` — after resume, check prior context before asking user.
1. **GATHER**: `open_ctx_batch_execute(commands, queries)` — runs all commands, auto-indexes, returns search. ONE call replaces 30+. Each command: `{label: "header", command: "..."}`.
2. **FOLLOW-UP**: `open_ctx_search(queries: ["q1", "q2", ...])` — all questions as array, ONE call (default relevance mode).
3. **PROCESSING**: `open_ctx_execute(language, code)` | `open_ctx_execute_file(path, language, code)` — sandbox, only stdout enters context.
4. **WEB**: `open_ctx_fetch_and_index(url, source)` then `open_ctx_search(queries)` — raw HTML never enters context.
5. **INDEX**: `open_ctx_index(content, source)` — store in FTS5 for later search.

## Parallel I/O batches

For multi-URL fetches or multi-API calls, **always** include `concurrency: N` (1-8):

- `open_ctx_batch_execute(commands: [3+ network commands], concurrency: 5)` — gh, curl, dig, docker inspect, multi-region cloud queries
- `open_ctx_fetch_and_index(requests: [{url, source}, ...], concurrency: 5)` — multi-URL batch fetch

**Use concurrency 4-8** for I/O-bound work (network calls, API queries). **Keep concurrency 1** for CPU-bound (npm test, build, lint) or commands sharing state (ports, lock files, same-repo writes).

GitHub API rate-limit: cap at 4 for `gh` calls.

## Output

Write artifacts to FILES — never inline. Return: file path + 1-line description.
Descriptive source labels for `open_ctx_search(source: "label")`.

## Session Continuity

Skills, roles, and decisions captured earlier in the session are background, not standing orders. When they disagree with what the user just asked for, the most recent request wins.

## Memory

Session history is persistent and searchable. On resume, search BEFORE asking the user:

| Need | Command |
|------|---------|
| What did we decide? | `open_ctx_search(queries: ["decision"], source: "decision", sort: "timeline")` |
| What constraints exist? | `open_ctx_search(queries: ["constraint"], source: "constraint")` |

Search these before asking the user anything about earlier work. Zero results means fresh session — proceed.

## ctx commands

| Command | Action |
|---------|--------|
| `open-context-mode stats` | Call `stats` MCP tool, display full output verbatim |
| `open-context-mode doctor` | Call `doctor` MCP tool, run returned shell command, display as checklist |
| `open-context-mode purge` | Call `purge` MCP tool with confirm: true. Warns before wiping knowledge base. |

After /clear or /compact: knowledge base and session stats preserved. Use `open-context-mode purge` to start fresh.
