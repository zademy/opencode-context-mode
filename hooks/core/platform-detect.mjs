/**
 * Platform detection from process env vars.
 *
 * Each supported platform sets a distinctive env var when invoking
 * hook scripts; we use those to pick the correct tool-namer prefix
 * and routing block. Falls back to "claude-code" when nothing matches
 * so existing CC behavior is preserved.
 *
 * SINGLE SOURCE OF TRUTH: derived from the platform-identity table
 * (src/platform-identity.ts), consumed here through the committed esbuild
 * artifact hooks/platform-identity.bundle.mjs — the SAME table behind
 * `PLATFORM_ENV_VARS` in src/platforms/detect.ts. The hand-synced mirror
 * this file used to carry had already drifted (it omitted the #539
 * disambiguators CLAUDE_CODE_ENTRYPOINT/CLAUDE_PLUGIN_ROOT, the omp
 * entry, and treated the detect:false PI_*_DIR vars as detectable —
 * #542); deriving from the table makes that class of drift impossible.
 *
 * Order matters — same as the table (forks listed BEFORE the fork's
 * parent so collision detection works, e.g. cursor BEFORE vscode-copilot
 * because Cursor inherits VSCODE_PID as a fork; antigravity BEFORE
 * vscode-copilot for the same reason).
 */
import { PLATFORM_ENV_VAR_TABLE } from "../platform-identity.bundle.mjs";

// Derived mirror of the platform-identity table: only entries that
// participate in detection (`detect !== false` — issue #542's consumer-set
// PI_*_DIR workspace vars are scrubbed here), names in registry order.
const PLATFORM_ENV_VARS_MIRROR = PLATFORM_ENV_VAR_TABLE.map(([platform, entries]) => [
  platform,
  entries.filter((e) => e.detect !== false).map((e) => e.name),
]);

export function detectPlatformFromEnv(env = process.env) {
  for (const [platform, vars] of PLATFORM_ENV_VARS_MIRROR) {
    if (vars.some((v) => env[v])) return platform;
  }
  return "claude-code";
}

// Re-exported for tests so they can assert against the same canonical table.
export { PLATFORM_ENV_VARS_MIRROR };
