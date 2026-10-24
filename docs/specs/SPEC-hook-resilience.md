# SPEC — hook-resilience

**Status:** Implemented 2026-10-24 (see Implementation Record)
**Module:** `hook-resilience` (SPEC-map build order #1)

## Problem

The plugin runs in-process inside the host's (OpenCode/Kilo) turn loop. Every hook callback (`before`, `after`, `onEvent`, `onPrompt`, `onCompaction`, `onContext`) and the init path execute inside the host. Before this module there was no uniform guarantee that an internal error stays inside the plugin:

- **v2 registrations are raw callbacks.** `ctx.tool.hook("execute.before", cb)` and siblings receive unwrapped handlers. Whether the host catches hook errors is undocumented and version-dependent — a throw may break the turn.
- **v1 HookEntry array** had the same exposure.
- **Init was all-or-nothing.** `initState()` performed four dynamic ESM imports (`routing.mjs`, `routing-block.mjs`, `tool-naming.mjs`, `auto-injection.mjs`), opened SessionDB, and built tool specs. One failed import or a locked DB rejected `initState` → the plugin failed to load entirely. Whole mode dead, no degradation.
- **DB writes inline in handlers.** `insertEvent` calls inside `after`/`onEvent` could throw (disk full, locked) and propagate into the host.

Existing partial guards: `safeLog` never rejects; `describeError` exists; the security module had a fail-open/fail-closed policy (`OPEN_CONTEXT_MODE_REQUIRE_SECURITY=1`). This module generalized them into one boundary.

## Goals

1. **Fail-safe boundary at every hook registration site** (v1 and v2). On error: describe it, report via safeLog, return passthrough.
2. **Init degrades, never dies.** A failed capability at init disables only that capability; the plugin still loads and the rest keeps working.
3. **Diagnosable failures.** Every caught error carries: hook name, error message, and a one-line statement of what was skipped.
4. **Preserve existing policy semantics.** Fail-open default; fail-closed under `OPEN_CONTEXT_MODE_REQUIRE_SECURITY=1` is a deliberate deny, not an error path — untouched.

## Non-Goals

- OpenCode V2 internals drift detection / version handling → module `v2-compat`.
- FTS5 corruption healing / index recovery → module `store-resilience`.
- Sandbox timeouts / orphan-process cleanup → module `executor-resilience`.
- Doctor checks for these failure modes → module `diagnostics`.
- Retry logic with backoff — a failed side effect is skipped, not retried.

## Resolved Decisions (user: "aplica lo que recomiendes para opencode v2")

| Open question | Decision | Rationale |
|---|---|---|
| Circuit breaker | **Yes, N=3 consecutive failures → hook disabled for the process, one log line.** Success resets the counter. | Three consecutive failures of the same hook = systematic breakage (host shape drift, corrupt state); failing every turn adds noise and latency for nothing. |
| Degraded-init visibility | **Log-only.** The injected routing block stays stable. | Prompt real estate is versioned/cached; the tools themselves already report their own errors loudly; diagnostics (later module) is the right surface for visibility. |
| v1 scope | **v2 was the priority, but v1 got covered for free** by binding the wrapper inside `initState` (single choke point shared by both API generations) instead of at each v2 registration site. | Less code than a v2-only wrap; v1+V2 stay behaviorally identical by construction. |

## Success Criteria — Verification

- [x] Every hook handler (`before`, `after`, `onEvent`, `onPrompt`, `onCompaction`, `onContext`) passes through the single `failSafe` wrapper — bound once inside `initState`, covering v1 HookEntry and v2 registrations alike.
- [x] Wrapper unit tests: throwing handler → passthrough, one safeLog line, no rethrow (8 tests in `tests/adapters/hook-resilience.test.ts`).
- [x] Deliberate denies rethrow: `RoutingDenyError` (extends Error) marks the deny throw; `failSafe` rethrows it untouched, so blocking decisions still block on every host.
- [x] `initState` test: broken routing import → degraded state (routing stub returns null decision → passthrough), plugin loads.
- [x] `initState` test: DB open failure → no-op SessionDB stub, `after()` resolves.
- [x] `initState` test: broken routing-block import → `routingBlock === ""`, injection skipped.
- [x] Full suite: 3085 passed / 26 skipped / 1 pre-existing unrelated failure (`sh-posix-guard` on `.agents/skills/idea-refine/scripts/idea-refine.sh`, from commit "add: agents").
- [x] Lint 0 errors (476 pre-existing tracked warnings); format check passes.

## Boundaries (as implemented)

**Always:**
- One choke point (`failSafe`), not per-site try/catch.
- Fail-open on handler errors: skip the side effect, continue the turn.
- Report every swallowed error via `logSafe` (fire-and-forget, can itself never throw or reject).
- Preserve `REQUIRE_SECURITY` fail-closed behavior.

**Never:**
- Silently swallow a routing deny decision (`RoutingDenyError` rethrows).
- Retry a failing side effect inside the hook.
- Break the host turn — the one invariant this module exists to protect.

## Implementation Record (2026-10-24)

Files changed:
- `src/platforms/opencode/plugin.ts`
  - `RoutingDenyError` class — marked deny/ask throw in `handlers.before`; every host still sees an `Error`.
  - `failSafe(hookName, safeLog, fn)` — try/catch boundary + per-hook circuit breaker (`HOOK_FAILURE_THRESHOLD = 3`, per-process `hookHealth` map, success resets).
  - `logSafe(safeLog, message, extra)` — fire-and-forget logging that can never throw/reject into the failure path.
  - `initState(projectDir, safeLog, deps?)` — new `InitStateDeps` test-injection param; every capability import (`routing`, `security`, `routing-block`, `tool-naming`, `auto-injection`), the SessionDB open, and `buildToolSpecs()` guarded individually; failures recorded in `ContextModeState.degraded: string[]` with one logSafe detail line each plus a summary line; routing falls back to a null-decision stub, DB to a no-op stub, routing block to `""` (injection skipped).
  - Handlers bound through `failSafe` inside `initState` — covers v1 HookEntry + v2 registrations in one place.
- `tests/adapters/hook-resilience.test.ts` (new) — 8 tests: passthrough, deny rethrow, breaker disable+single log, counter reset, return preservation, and the three initState degradation scenarios.

Verification: `npx vp test run` → 3085 passed / 1 pre-existing unrelated failure; `npm run lint` → 0 errors; `npm run format:check` → pass.
