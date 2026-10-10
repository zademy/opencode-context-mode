/**
 * Shared dependency bootstrap for hooks and start.mjs.
 *
 * Single source of truth — ensures native deps (better-sqlite3) are
 * installed in the plugin cache before any hook or server code runs.
 *
 * Pattern: same as suppress-stderr.mjs — imported at the top of every
 * hook that needs native modules. Fast path: existsSync check (~0.1ms).
 * Slow path: npm install (first run only, ~5-30s).
 *
 * Also handles ABI compatibility (#148, #203): when the current Node.js
 * version differs from the one better-sqlite3 was compiled against,
 * automatically swaps in a cached binary or rebuilds. This protects
 * both the MCP server AND hooks from ABI mismatch crashes when users
 * have multiple Node versions via mise/volta/fnm/nvm.
 *
 * @see https://github.com/mksglu/open-context-mode/issues/148
 * @see https://github.com/mksglu/open-context-mode/issues/172
 * @see https://github.com/mksglu/open-context-mode/issues/203
 */

import { existsSync, copyFileSync, renameSync, unlinkSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { delimiter, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Shared 3-layer heal helper (also used by scripts/postinstall.mjs).
// Lazy-loaded via dynamic import so older installs and synthetic test
// harnesses (e.g. tests/session-hooks-smoke) — which don't ship
// `scripts/heal-better-sqlite3.mjs` — degrade to a no-op instead of
// crashing the hook with ERR_MODULE_NOT_FOUND. Best-effort posture
// matches the rest of this module.
async function healBetterSqlite3Binding(pkgRoot) {
  try {
    const helperPath = resolve(__dirname, "..", "scripts", "heal-better-sqlite3.mjs");
    if (!existsSync(helperPath)) return { healed: false, reason: "helper-missing" };
    const mod = await import(pathToFileURL(helperPath).href);
    return mod.healBetterSqlite3Binding(pkgRoot);
  } catch {
    return { healed: false, reason: "helper-error" };
  }
}

const NATIVE_DEPS = ["better-sqlite3"];
const NATIVE_BINARIES = {
  "better-sqlite3": ["build", "Release", "better_sqlite3.node"],
};

/**
 * Check if the current runtime has built-in SQLite support.
 * Bun has bun:sqlite, Node >= 22.5 has node:sqlite.
 *
 * Used to skip the SIGSEGV-prone child-process probe on modern Node (#331),
 * but NOT to skip installing better-sqlite3 — the bundle unconditionally
 * requires it as a fallback on non-Linux platforms (#371).
 */
function hasModernSqlite() {
  if (typeof globalThis.Bun !== "undefined") return true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

// Install failure backoff (#1139, #1174). ensureDeps() runs on EVERY hook
// invocation. When the install cannot succeed (npm's Arborist crashing inside
// the plugin dir, offline, registry errors), retrying synchronously on each
// call spawns an npm process per tool call that never converges. A marker in
// the plugin root records the attempt: while one is in flight other hook
// calls skip it, and after a failure the install is retried at most once per
// INSTALL_RETRY_MS — or immediately under a different Node version.
const INSTALL_RETRY_MS = 60 * 60 * 1000;
const INSTALL_INFLIGHT_MS = 5 * 60 * 1000; // > the 120s execSync timeout

function installMarkerPath(pkg) {
  return resolve(root, `.ensure-deps-${pkg}.install-state.json`);
}

function installBackoffActive(pkg) {
  try {
    const m = JSON.parse(readFileSync(installMarkerPath(pkg), "utf-8"));
    const age = Date.now() - Number(m.at);
    if (!(age >= 0)) return false;
    if (m.pending) return age < INSTALL_INFLIGHT_MS;
    return m.node === process.version && age < INSTALL_RETRY_MS;
  } catch {
    return false; // no marker (or unreadable) — install as before
  }
}

function writeInstallMarker(pkg, data) {
  try {
    writeFileSync(installMarkerPath(pkg), JSON.stringify({ at: Date.now(), node: process.version, ...data }));
  } catch {
    /* read-only plugin dir — fall back to the old behavior */
  }
}

export async function ensureDeps() {
  // Bun ships bun:sqlite and never needs better-sqlite3
  if (typeof globalThis.Bun !== "undefined") return;
  for (const pkg of NATIVE_DEPS) {
    const pkgDir = resolve(root, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      // Package not installed at all
      if (installBackoffActive(pkg)) continue;
      writeInstallMarker(pkg, { pending: true });
      let error = "";
      try {
        // #863: run npm's own CLI through node directly. "npm.cmd" +
        // shell:true DROPS the cwd option on Windows, so npm resolves
        // node_modules from the inherited cwd (C:\Windows under Claude
        // Code) and the install dies on EPERM every boot (#861 reporter listed
        // better-sqlite3 among them). shell:false honors cwd. Mirrors the
        // start.mjs idiom (#861); the shim stays only as a fallback for hosts
        // where npm-cli.js is not beside node, so nothing regresses.
        const npmCliJs = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
        const installArgs = ["install", pkg, "--no-package-lock", "--no-save", "--silent"];
        if (existsSync(npmCliJs)) {
          execFileSync(process.execPath, [npmCliJs, ...installArgs], {
            cwd: root,
            stdio: "pipe",
            timeout: 120000,
            windowsHide: true,
          });
        } else {
          execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", installArgs, {
            cwd: root,
            stdio: "pipe",
            timeout: 120000,
            shell: process.platform === "win32",
            windowsHide: true,
          });
        }
      } catch (err) {
        /* best effort — hook degrades gracefully without DB */
        // err.stderr is a Buffer (empty under --silent), so fall back to the message.
        error = (String(err?.stderr ?? "").trim() || String(err?.message ?? err)).slice(-500);
      }
      if (existsSync(pkgDir)) {
        try {
          unlinkSync(installMarkerPath(pkg));
        } catch {
          /* already gone */
        }
      } else {
        writeInstallMarker(pkg, { error: error || "install finished but package is still missing" });
      }
    } else if (!existsSync(resolve(pkgDir, ...NATIVE_BINARIES[pkg]))) {
      // Package installed but native binary missing (e.g., npm ignore-scripts=true,
      // or Windows where `npm rebuild` falls through to node-gyp without MSVC — #408).
      // Delegate to the shared 3-layer heal (single source of truth, also used by
      // scripts/postinstall.mjs).
      try {
        await healBetterSqlite3Binding(root);
      } catch {
        /* helper already best-effort */
      }
    }
  }
}

/**
 * Probe-load better-sqlite3 in a child process to verify the binary on disk
 * is compatible with the current Node ABI. In-process require() caches native
 * modules at the dlopen level, so it can't detect on-disk binary changes.
 * A child process gets a fresh dlopen cache.
 *
 * Note: require('better-sqlite3') only loads the JS wrapper — the native
 * binary is lazy-loaded when instantiating a Database. We must create an
 * in-memory DB to actually trigger dlopen.
 */
function probeNativeInChildProcess(pluginRoot) {
  try {
    execFileSync(process.execPath, ["-e", "new (require('better-sqlite3'))(':memory:').close()"], {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// Identity of the ABI cache and of the active binary it was installed as.
// The active binary cannot be byte-compared with the cache (ad-hoc codesign
// rewrites it), so a swap records both stats in a stamp file and later calls
// skip the copy + codesign + rename while they still match (#1196). Anything
// else that replaces the active binary (npm rebuild, another ABI's swap)
// changes its stat and forces a fresh swap.
function nativeSwapStamp(abiCachePath, binaryPath) {
  try {
    const c = statSync(abiCachePath);
    const b = statSync(binaryPath);
    return `${abiCachePath}:${c.size}:${c.mtimeMs}|${b.size}:${b.mtimeMs}:${b.ino}`;
  } catch {
    return null;
  }
}

/**
 * File the working binary as the cache entry for THIS process's Node ABI.
 *
 * Two invariants, both about the name/bytes pair:
 *
 *   1. The name is a claim. `abiCachePath` is spelled with
 *      `process.versions.modules`, so every caller must be a Node process that
 *      either probed the binary (the `probeNativeInChildProcess` branches) or
 *      rebuilt it with `envWithRunningNodeFirst()` — never a process that
 *      cannot observe the real ABI (see the Bun early return in
 *      `ensureNativeCompat`, issue #1193).
 *   2. The bytes must not be observable half-written. Two hook processes
 *      starting together can have one reading `abiCachePath` via
 *      `copyFileSync` while the other truncates that same path; the reader
 *      gets a short file and renames it into the live slot. Temp + rename in
 *      the same directory closes that, the same treatment the active-binary
 *      swap already got in #587/#591.
 *
 * Best-effort: a failure here leaves the previous entry in place, which the
 * next boot re-derives.
 */
export function seedAbiCacheEntry(abiCachePath, binaryPath) {
  if (!existsSync(binaryPath)) return;
  const tmpPath = `${abiCachePath}.staging-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(binaryPath, tmpPath);
    renameSync(tmpPath, abiCachePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }
  }
}

function replaceActiveNativeBinaryFromCache(abiCachePath, binaryPath) {
  const stampPath = `${binaryPath}.swap-stamp`;
  const current = nativeSwapStamp(abiCachePath, binaryPath);
  if (current !== null) {
    try {
      if (readFileSync(stampPath, "utf8") === current) return;
    } catch {
      /* no stamp yet — swap below */
    }
  }
  const tmpPath = `${binaryPath}.staging-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(abiCachePath, tmpPath);
    codesignBinary(tmpPath);
    renameSync(tmpPath, binaryPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
  // A missing or unwritable stamp only means the next call swaps again.
  const installed = nativeSwapStamp(abiCachePath, binaryPath);
  if (installed === null) return;
  const stampTmp = `${stampPath}.${process.pid}-${Date.now()}`;
  try {
    writeFileSync(stampTmp, installed);
    renameSync(stampTmp, stampPath);
  } catch {
    try {
      unlinkSync(stampTmp);
    } catch {
      /* best effort cleanup */
    }
  }
}

export function ensureNativeCompat(pluginRoot) {
  // Pre-compute paths regardless of runtime. `abi` is the CURRENT process's
  // Node ABI, and it is the name every cache entry below is filed under — so
  // an entry is only ever written by a process that can stand behind that
  // name (see seedAbiCacheEntry).
  const abi = process.versions.modules;
  const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
  const binaryPath = resolve(nativeDir, "better_sqlite3.node");
  const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

  // Bun ships bun:sqlite — better-sqlite3 is never dlopened under Bun (the
  // `globalThis.Bun` branch of loadDatabase in src/db-base.ts). And under Bun
  // this process CANNOT state which ABI the binary on disk was built for:
  // `process.versions.modules` is spoofed to a plausible Node level. Seeding
  // `better_sqlite3.abi<spoofed>.node` from whatever the last `npm rebuild`
  // produced therefore wrote an entry whose NAME claimed one ABI and whose
  // BYTES were another (issue #1193). Nothing downstream validated the claim,
  // and the cache-hit fast path below swaps the entry into the live slot on a
  // name match alone, so a Node booting at the spoofed ABI installed the wrong
  // bytes as `better_sqlite3.node`. The next real Node boot writes this entry
  // from a binary IT probed, so the marker stays a claim somebody verified.
  // #543's spurious "Native addon ABI cache missing" warning is answered at
  // the consumer (src/cli.ts), which no longer demands a marker under Bun.
  if (typeof globalThis.Bun !== "undefined") return;

  // On Node >= 22.5, skip the child-process probe that can cause SIGSEGV (#331).
  // The binary install/rebuild still runs — only the dlopen probe is skipped.
  const skipProbe = hasModernSqlite();

  try {
    if (!existsSync(nativeDir)) return;

    // Fast path: cached binary for this ABI already exists — swap in
    if (existsSync(abiCachePath)) {
      replaceActiveNativeBinaryFromCache(abiCachePath, binaryPath);
      if (skipProbe) return; // Trust the cached binary — skip SIGSEGV-prone probe
      // Validate via child process — dlopen cache is per-process, so in-process
      // require() can't detect a swapped binary on disk (#148)
      if (probeNativeInChildProcess(pluginRoot)) {
        return; // Cache hit validated
      }
      // Cached binary is stale/corrupt — fall through to rebuild
    }

    if (skipProbe) {
      // Seed the ABI cache from a working binary before falling back to rebuild;
      // otherwise a missing cache forces npm rebuild on every hook invocation.
      // The probe runs in a CHILD, never here (#1188). #331 replaced the child
      // probe with an in-process dlopen to stop the child from SIGSEGVing —
      // but a failed dlopen does not unmap the library, so the rebuild on the
      // next line replaced the bytes of a file this process still held mapped
      // under PROT_EXEC, and the process died on the next access. Reverting to
      // the child probe puts the mapping back where a crash is survivable: the
      // child dies, execFileSync throws, and this process is untouched. Cost is
      // bounded — this branch is only reached on an ABI-cache MISS, and both
      // exits below seed the cache, so it runs at most once per install+ABI.
      if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
        seedAbiCacheEntry(abiCachePath, binaryPath);
        return;
      }
      execSync(`${process.platform === "win32" ? "npm.cmd" : "npm"} rebuild better-sqlite3 --ignore-scripts=false`, {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
        shell: true,
        env: envWithRunningNodeFirst(),
      });
      codesignBinary(binaryPath);
      seedAbiCacheEntry(abiCachePath, binaryPath);
      return;
    }

    // Probe: try loading better-sqlite3 with current Node
    if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
      // Load succeeded — cache the working binary for this ABI
      seedAbiCacheEntry(abiCachePath, binaryPath);
    } else {
      // ABI mismatch or missing native binary — rebuild for current Node version
      execSync(`${process.platform === "win32" ? "npm.cmd" : "npm"} rebuild better-sqlite3 --ignore-scripts=false`, {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
        shell: true,
        env: envWithRunningNodeFirst(),
      });
      codesignBinary(binaryPath);
      if (existsSync(binaryPath) && probeNativeInChildProcess(pluginRoot)) {
        seedAbiCacheEntry(abiCachePath, binaryPath);
      }
    }
  } catch {
    /* best effort — caller will report the error on first DB access */
  }
}

function envWithRunningNodeFirst() {
  const env = {};
  // Windows treats environment keys case-insensitively. Remove any existing
  // Path/PATH entry before adding one authoritative value for the child.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== "path") env[key] = value;
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
  return env;
}
/**
 * Ad-hoc codesign a native binary on macOS.
 *
 * When a cached .node binary is copied over the active one, macOS hardened
 * runtime (e.g. Zed, VS Code with runtime hardening) will SIGKILL the
 * process on the next dlopen because the code signature is invalidated.
 * SIGKILL is uncatchable — the only fix is to re-sign after the copy.
 *
 * No-op on non-macOS. Swallows errors (codesign may not be available in
 * all environments, e.g. Docker containers).
 */
export function codesignBinary(binaryPath) {
  if (process.platform === "darwin") {
    try {
      execSync(`codesign --sign - --force "${binaryPath}"`, {
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      /* codesign unavailable — continue without signing */
    }
  }
}

// Auto-run on import (like suppress-stderr.mjs).
// Top-level await ensures the heal completes before the importer's next
// statement runs (which is typically `new Database(...)`).
await ensureDeps();
ensureNativeCompat(root);
