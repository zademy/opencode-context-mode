# SPEC — hook-resilience

**Status:** Draft — awaiting review
**Module:** `hook-resilience` (SPEC-map build order #1)

## Problem

The plugin runs in-process inside the host's (OpenCode/Kilo) turn loop. Every hook callback (`before`, `after`, `onEvent`, `onPrompt`, `onCompaction`, `onContext`) and the init path execute inside the host. Today there is no uniform guarantee that an internal error stays inside the plugin:

- **v2 registrations are raw callbacks.** `ctx.tool.hook("execute.before", cb)` and siblings receive unwrapped handlers. Whether the host catches hook errors is undocumented and version-dependent — a throw may break the turn.
- **v1 HookEntry array** has the same exposure.
- **Init is all-or-nothing.** `initState()` performs four dynamic ESM imports (`routing.mjs`, `routing-block.mjs`, `tool-naming.mjs`, `auto-injection.mjs`), opens SessionDB, reads AGENTS.md, and builds tool specs. One failed import or a locked DB rejects `initState` → the plugin fails to load entirely. Whole mode dead, no degradation.
- **DB writes inline in handlers.** `insertEvent` calls inside `after`/`onEvent` can throw (disk full, locked) and propagate into the host.

Existing partial guards: `safeLog` never rejects; `describeError` exists; the security module has a fail-open/fail-closed policy (`OPEN_CONTEXT_MODE_REQUIRE_SECURITY=1`). These are precedents to generalize, not new policy.

## Goals

1. **Fail-safe boundary at every hook registration site** (v1 and v2). On error: describe it, report via `safeLog`, return passthrough (v2: undefined/default; v1: leave the output object untouched).
2. **Init degrades, never dies.** A failed capability at init (routing import, DB open, tool specs) disables only that capability; the plugin still loads and the rest keeps working.
3. **Diagnosable failures.** Every caught error carries: hook name, tool name (if any), sessionId, error message, and a one-line statement of what was skipped.
4. **Preserve existing policy semantics.** Fail-open default; fail-closed under `OPEN_CONTEXT_MODE_REQUIRE_SECURITY=1` is a deliberate deny, not an error path — untouched.

## Non-Goals

- OpenCode V2 internals drift detection / version handling → module `v2-compat`.
- FTS5 corruption healing / index recovery → module `store-resilience`.
- Sandbox timeouts / orphan-process cleanup → module `executor-resilience`.
- Doctor checks for these failure modes → module `diagnostics`.
- Retry logic with backoff — a failed side effect is skipped, not retried (retries, if ever, belong to `store-resilience`).

## User Stories

1. As an agent using the plugin, when SessionDB is locked, my tool calls still execute — post-hook capture is skipped with a logged warning, and the turn is unaffected.
2. As an npm user, when OpenCode V2 changes an event shape and a handler receives unexpected input, the plugin logs the error and the session continues without capture, instead of the turn breaking.
3. As a plugin user with a broken install (partial update, missing `.mjs`), the plugin loads in degraded mode and logs exactly which capability is missing, instead of silently failing to load.

## Success Criteria

- [ ] Every hook callback registered in `setupContextModeV2` (`tool.execute.before`/`after`, event, `chat.message`, `session.compacting`, `chat.system.transform`) and every v1 HookEntry passes through a single fail-safe wrapper.
- [ ] Wrapper unit tests: a throwing handler returns passthrough, `safeLog` is called once with hook name + error, nothing rethrows.
- [ ] `initState` test: broken routing import → degraded state (routing no-op, capture active) instead of a rejected promise.
- [ ] `initState` test: DB open failure → degraded state, hooks no-op safely.
- [ ] `after` test: `insertEvent` throws → error does not propagate.
- [ ] Full existing test suite passes; lint + format checks pass (project pre-commit bar).

## Boundaries

**Always:**
- One choke point (a single wrapper), not per-site try/catch.
- Fail-open on handler errors: skip the side effect, continue the turn.
- Report every swallowed error via `safeLog` — never silent.
- Preserve `REQUIRE_SECURITY` fail-closed behavior.

**Ask First:**
- Circuit breaker: auto-disable a hook after N consecutive failures (proposal: N=3, log once).
- Degrade granularity at init: per-capability (routing off, capture on) vs whole-plugin no-op.
- Any change to hook registration order or removal of a hook.

**Never:**
- Silently swallow a routing deny decision.
- Retry a failing side effect inside the hook (adds latency to the turn).
- Scatter per-site try/catch instead of the single wrapper.
- Break the host turn — the one invariant this module exists to protect.

## Technical Direction (sketch — Plan phase will finalize)

- `failSafe(name, fn)` wrapper in `src/platforms/opencode/plugin.ts`, colocated with `describeError` + `safeLog`: try/catch, describe, log, return the passthrough value per hook kind.
- `initState` gains per-capability guards: each dynamic import and the DB open wrapped; failures recorded in a new `ContextModeState.degraded: string[]`; routing falls back to passthrough.
- v1 hook entries route through the same wrapper via a shared helper.
- Tests in `tests/adapters/hook-resilience.test.ts`: inject throwing fakes, assert passthrough + logged warning + no throw.

## Open Questions (answers needed before Plan phase)

1. **Circuit breaker** — disable a hook after N consecutive failures (N=3, one log line), or keep trying every event?
2. **Degraded-init visibility** — log-only, or should the injected routing block also mention "context-mode degraded: X unavailable"?
3. **v1 scope** — wrap v1 hooks in this module too, or v2-only here and v1 in a follow-up?
