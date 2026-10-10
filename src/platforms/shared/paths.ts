/**
 * Tilde-aware path resolution shared by every config-dir idiom in the repo.
 *
 * One canonical expansion of `~`/`~/`/`~\` against `homedir()` (a single
 * leading slash OR backslash is stripped, so `~\Users\foo` works on Windows)
 * with non-tilde values resolved absolute against cwd. Callers own the
 * env-var presence/whitespace guard — contracts differ per env var
 * (`CODEX_HOME` is plain truthy-check, `CLAUDE_CONFIG_DIR` trims) so the
 * guard stays at each call site and only the expansion lives here.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

export function resolveTildePath(raw: string): string {
  if (raw.startsWith("~")) {
    return resolve(homedir(), raw.replace(/^~[/\\]?/, ""));
  }
  return resolve(raw);
}
