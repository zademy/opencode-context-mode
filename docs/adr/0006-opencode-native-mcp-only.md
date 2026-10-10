---
status: accepted
---

# OpenCode-native; MCP-only for every other agent

The upstream project stopped taking improvements, so this fork serves one platform natively: OpenCode ≥ 2.0, driven through its own plugin API and hooks. Every other agent keeps working over the MCP protocol and nothing else — their adapters, hook runtimes, config templates and plugin manifests are deleted rather than kept warm.

## Considered Options

- **Keep the 18 adapters, deprioritise OpenCode.** Rejected: maintaining them is the exact cost this fork exists to stop paying, and OpenCode is the only host whose API lets open-context-mode run the MCP server in-process and reach the session data at all.
- **Keep per-agent hook installs for the others.** Rejected: MCP exposes no session events, so an MCP-only client can never reach parity on capture, compaction snapshots or directive injection. Paying for a second-class path is how the current 18 got stale.

## Consequences

- Non-OpenCode clients lose hook-only capture: compaction snapshots, session-start directive injection, and host transcript parsing. What survives is what the MCP server observes about itself — its tool calls and results.
- Platform identity becomes data, never behaviour: one storage route, and a platform label carried in the SQLite `platform` column, read from a sanitised MCP `clientInfo.name` rather than from a hand-kept table.
- `src/adapters/` is renamed to `src/platforms/`: one integration remains, so the plural name and the old *Adapter* definition both stopped being true.
- Package surface breaks (manifests, `exports`, plugin install paths) — released as 3.0.0.