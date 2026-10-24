# SPEC Map — Robustness (Solidez)

**Status:** Approved 2026-10-24
**Source of intent:** Confirmed interview, 2026-10-24

## Confirmed Intent

Harden open-context-mode on two fronts:

1. **Own-failure handling** — hooks, FTS5 index, sandbox, timeouts — with graceful degradation and recovery.
2. **Defensive compatibility with OpenCode V2** — internals drift (event shapes, tool registration, routing-block splice), degrade instead of crash.

Success: a failure never breaks the agent's session — the plugin detects, degrades cleanly, or recovers, and reports what happened.
Constraint: stay within the project's general purpose (context routing for OpenCode).
Out of scope: new product features, adoption/marketing, large rewrites.

## Capability Map

| Module | Responsibility | Depends on | Status |
|---|---|---|---|
| `hook-resilience` | Hook callbacks and init never break the host turn: fail-safe boundary, degraded init, diagnosable errors | — | Draft spec |
| `store-resilience` | FTS5/SQLite corruption and unexpected states: heal, rebuild, or degrade to linear search without killing the session | — | Not started |
| `executor-resilience` | Sandbox (PolyglotExecutor): guaranteed timeouts, orphan-process cleanup, runtime failures reported without hanging the tool | — | Not started |
| `v2-compat` | Defensive compat with OpenCode V2: drift detection (event shapes, tool names, hook registration, routing-block splice), version-aware degradation | `hook-resilience` | Not started |
| `diagnostics` | Extend doctor to diagnose every failure scenario introduced above — user can self-verify their installation | all four above | Not started |

## Build Order

`hook-resilience` → `store-resilience` ∥ `executor-resilience` (parallel) → `v2-compat` → `diagnostics`

Rationale: `hook-resilience` establishes the fail-safe pattern the others consume; `v2-compat` requires hooks that already fail safely; `diagnostics` verifies everything else, so it lands last.
