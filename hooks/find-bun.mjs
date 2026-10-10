// Resolve a bun binary from the known install locations and $PATH.
// Raw JS (not runtime.ts) so start.mjs can use it before build/ exists.
// Pure/injectable for tests.
import { posix, win32 } from "node:path";
import { existsSync as realExistsSync } from "node:fs";
import { homedir as realHomedir } from "node:os";

export function findBun({ env = process.env, platform = process.platform, home = realHomedir(), existsSync = realExistsSync } = {}) {
  // Candidate paths must follow the RESOLVED platform's semantics, not the
  // host's: path.join on Windows rewrites "/opt/bin" to "\opt\bin", which
  // breaks cross-platform resolution (and the pure tests).
  const join = platform === "win32" ? win32.join : posix.join;
  const exe = platform === "win32" ? "bun.exe" : "bun";
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin", exe) : null,
    home ? join(home, ".bun", "bin", exe) : null,
    join("/usr/local/bin", exe),
    join("/usr/bin", exe),
    ...(env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, exe)),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}
