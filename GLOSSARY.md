# open-context-mode

Language for the open-context-mode MCP server: what we call the things it manages.

## Language

**Platform**:
An agent this repo ships an integration for. Exactly one: OpenCode. Its hooks run in-process and register the tools directly.
_Avoid_: adapter (the integrations are not adapters — nothing adapts them)

**MCP client**:
Any other agent that reaches open-context-mode over the Model Context Protocol and nothing else. It gets the tools and the server; it gets no hooks, so the token accounting it sees is its own.
_Avoid_: platform, supported agent

**Client label**:
The sanitized `clientInfo.name` an MCP client sends at initialize, or `mcp` when it says nothing usable. Stored in the `platform` column as data; it never decides where anything lives.

**Dashboard**:
The local, read-only web view of the user's SQLite data, started from the CLI and alive only while that process runs.
_Avoid_: tablero, local insight, web UI

**Insight**:
The hosted analytics product at open-context-mode.com/insight. Distinct from the Dashboard, which never leaves the user's machine.
_Avoid_: dashboard (when meaning the hosted product)

**Report**:
The terminal-rendered narrative that `open_ctx_stats` returns. Text-only; the Dashboard is its visual sibling, not its replacement.

**Session event**:
One recorded fact about a conversation: a decision, an error, a file touched. The atomic unit of analytics.

**Capture**:
One command output indexed into the knowledge base instead of entering the context window.

**Rescue bytes**:
Conversation content recovered from a compaction via snapshot replay.

**Avoided tokens**:
Output open-context-mode indexed into SQLite instead of sending to the model — the context-window spend that never happened.
_Avoid_: saved tokens (when meaning this measure)

**Returned tokens**:
Output the model actually re-read through open-context-mode lookups — the spend that did happen.

**With/without comparison**:
The counterfactual pair. "With" counts returned tokens; "without" counts returned plus avoided.
_Avoid_: savings percentage without the pair

**Estimated saved cost**:
Avoided tokens valued at the current per-token price; an estimate, never a bill.