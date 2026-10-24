import { defineConfig } from "vite-plus";

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // afterAll cleanup loops over many better-sqlite3 handles on Windows
    // and can exceed vitest's default 10s hookTimeout under fork contention
    // (e.g. tests/session/session-pipeline.test.ts cleans every DB it
    // created). Match testTimeout so the cleanup window matches the work
    // window — same envelope better-sqlite3 already needs for tests.
    hookTimeout: 30_000,
    // Native addons (better-sqlite3) can segfault in worker_threads during
    // process cleanup. Use forks on all platforms for stable isolation.
    pool: "forks",
    // Cap parallel workers to prevent fork exhaustion (#258).
    // Tests that spawnSync + better-sqlite3 cause worker SIGKILL under
    // unlimited parallelism. Benchmarked: 3 workers = 2.8x speedup with
    // near-zero crashes (vs unlimited = 3.7x but 6-7 worker kills/run).
    maxWorkers: isCI ? 2 : 3,
    // Hook subprocess tests (spawnSync + better-sqlite3 native addon) can
    // fail intermittently under parallel load on CI.  Retry once to absorb
    // transient resource-contention failures without masking real regressions.
    // Only enable retry on CI to avoid slowing down local dev.
    retry: isCI ? 2 : 0,
    // Force exit after tests complete — prevents CI failure from open handles
    // (better-sqlite3 native addon cleanup races with fork worker teardown).
    // Without this, Ubuntu CI consistently fails with "Worker exited unexpectedly"
    // even though all tests pass.
    teardownTimeout: isCI ? 15_000 : 5_000,
    // The suite spawns real MCP servers (open_ctx_execute -> shells) that
    // inherit stdio pipes. On win32 kill('SIGTERM') reaps only the direct
    // child, so a grandchild shell keeps the pipe open and vitest blocks
    // forever after the run. forceExit ends the process once results are in.
    forceExit: isCI,
    // Neutralize the platform pin the in-process OpenCode plugin sets on its
    // HOST env (src/adapters/opencode/plugin.ts:408). That host is the agent
    // process, so `npm test` launched from an OpenCode session inherits
    // OPEN_CONTEXT_MODE_PLATFORM=opencode into the worker and every spawned server.
    // detectPlatform() then takes the override tier, getProjectDir() builds the
    // cascade algorithmically for opencode (#545), and CLAUDE_PROJECT_DIR stops
    // counting as a workspace var — 14 tests in tests/core/server.test.ts
    // resolve against cwd instead of their tmpdir. "" is falsy so the
    // detector's `if (platformOverride)` skips the tier, same as unset; tests
    // that need a platform still set it themselves (detect.test.ts:434).
    env: { OPEN_CONTEXT_MODE_PLATFORM: "" },
  },
});
