---
name: open-context-mode
description: |
  Run code where the data lives — only the answer enters context. Use for any command,
  file, or API whose output you must read before answering: test and build logs,
  JSON/CSV/YAML, git history and diffs, CLI state (gh, aws, kubectl, docker),
  dependency trees, repo-wide greps and metrics, external docs, browser snapshots, any
  MCP result over ~20 lines. Tools: open_ctx_execute · open_ctx_execute_file ·
  open_ctx_batch_execute · open_ctx_search · open_ctx_index · open_ctx_fetch_and_index.
  Rare: open_ctx_stats · open_ctx_doctor · open_ctx_insight · open_ctx_purge.
---

# Open Context Mode

## The rule

**Print the answer, not the data.**

Raw output you read is context you spend for the rest of the session. Raw output you
never read is context you keep for the actual work. Derivation belongs where the inputs
are.

A failing suite needs its failing lines, not 3000 lines. A 40 MB log needs its errors,
not the log. Write the code that isolates them — in JavaScript, Python or shell — and let
it print only that.

## Bash stays where there is nothing to read back

Mutations and navigation: `mkdir` `mv` `cp` `rm` `touch` `chmod` · `cd` `pwd` `which` ·
`git add` `git commit` `git push` `git checkout` `git branch` `git merge` ·
`npm install` `pip install` · `kill` `pkill` · `echo` `printf`.

Single short observational commands: `whoami`, `git status` on a clean tree.
`ls` and `find` qualify only when the listing is a handful of lines — `ls -R` over a
repo is a derivation, not a listing.

Editing a file is Edit/Write. A file you intend to **edit** must be read with Read, so
the edit can match its exact text.

Everything else — anything that reads, queries, fetches, lists, diffs, logs, builds,
tests or inspects — goes through the sandbox.

## Pick the tool

| Situation | Tool |
|---|---|
| A command, and an answer derived from its output | `open_ctx_execute` |
| One file, and an answer derived from it | `open_ctx_execute_file` |
| 3+ commands or sources, plus questions about them | `open_ctx_batch_execute` |
| Web pages to consult | `open_ctx_fetch_and_index` |
| Content already indexed, or a past session | `open_ctx_search` |
| Reference worth keeping (API docs, tool schemas, a spec) | `open_ctx_index` |
| What open-context-mode itself saved; is it installed right | `open_ctx_stats` · `open_ctx_doctor` |
| Usage dashboard; delete indexed content | `open_ctx_insight` · `open_ctx_purge(confirm: true)` |

Per-tool detail: `/open-context-mode:open-ctx-search`, `:open-ctx-index`,
`:open-ctx-stats`, `:open-ctx-doctor`, `:open-ctx-insight`, `:open-ctx-purge`.

## Two levers that decide whether output lands or floods

**`intent: "<2-4 technical terms>"`** — pass it whenever output may exceed ~5 KB. The
output is indexed instead of returned: you get section titles plus previews, and
`open_ctx_search` retrieves the parts you later need. Without it the whole payload
enters context.

**`queries: ["q1", "q2", ...]`** — on `open_ctx_batch_execute` and `open_ctx_search`.
Every question in one array, one round trip. Never one call per question.

## Workflows

### Derive from a command

```javascript
const { execSync } = require('child_process');
const out = execSync('npm test', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(out.split('\n').filter(l => /(FAIL|✗|×|Error:|Tests +.*(failed|passed))/i.test(l)).slice(0, 40).join('\n'));
```

Wrap anything that can throw in `try/catch` — uncaught errors go to stderr, not through
your code path.

### Derive from a file

```python
import json
data = json.loads(FILE_CONTENT)      # pre-loaded in the sandbox, never in context
failed = [r for r in data if r.get("status") == "failed"]
print(f"{len(data)} records, {len(failed)} failed")
print(json.dumps(failed, indent=2)[:2000])
```

### Gather and query in one round trip

```javascript
open_ctx_batch_execute({
  commands: [
    { label: "history", command: "git log --oneline -50" },
    { label: "diff",    command: "git diff HEAD~5 --stat" },
    { label: "commits", command: "git show --stat HEAD~2 HEAD" },
  ],
  queries: ["root cause", "proposed fix"],
  concurrency: 3,
})
```

`concurrency` parallelizes the **fetch** phase only. Keep it at `1` for CPU-bound work
or shared state: builds, tests, linters, anything touching a lock file or a port.

### Recall later

```javascript
open_ctx_search({ queries: ["auth middleware", "token refresh"], source: "issue-683", limit: 3 })
```

`source` is a partial match on the label you gave that source — `"issue-683"`,
`"react"`, `"obsidian"`. Two to four technical terms per query; synonyms dilute the
ranking. Past-session memory carries its own labels: `decision`, `error`, `blocker`,
`plan`, `user-prompt`, `compaction`.

## Language

Pick the one whose standard library makes the job shortest.

- **`javascript`** — the default. `fs`, `path` and `child_process` are built in, so
  most work needs no subprocess. Use it for anything touching the filesystem or shelling
  out.
- **`shell`** — when the work *is* a CLI pipeline (`git log | grep | wc`).
- **`python`** — data-shaped work where `json`, `re` or `collections` is shorter than
  the JS equivalent.

Only `console.log` (JS/TS), `print` (Python/Ruby/Perl/R), `echo` (shell/PHP),
`fmt.Println` (Go), `IO.puts` (Elixir), `Console.WriteLine` (C#) reaches context.
Also available: typescript, ruby, go, rust, php, perl, r, elixir, csharp.

## Traps

| Looks right | Costs you |
|---|---|
| Bash for `ls -R`, `find`, `grep -r`, `git log`, `npm test` | the whole listing in context |
| Sandbox tool for reading a file you will edit | Read matches exact text; the sandbox does not |
| `open_ctx_index(content: <thing just returned>)` | **doubles** context — it is already in context. Write it to a file and index the path |
| One `open_ctx_search` call per question | N round trips. All questions in one `queries` array |
| Large third-party output with no `intent` | the full payload lands in context |
| `browser_navigate` output used as the snapshot | it already auto-returns a full page snapshot; call `browser_snapshot(filename)` to inspect |
| Expecting `open_ctx_stats` to reset anything | it is read-only; `open_ctx_purge(confirm: true)` deletes |

## Deep reference

- [JavaScript/TypeScript patterns](./references/patterns-javascript.md) — streaming
  reads, JSON, git and npm output, network calls
- [Python patterns](./references/patterns-python.md)
- [Shell patterns](./references/patterns-shell.md) — pipelines, log triage, portability
- [Anti-patterns](./references/anti-patterns.md) — the long tail, with fixes

