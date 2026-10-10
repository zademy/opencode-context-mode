/**
 * ensure-deps.mjs — TDD tests for native binary detection (#206)
 *
 * Tests the detection logic that determines whether to:
 * 1. npm install (package dir missing)
 * 2. npm rebuild (package dir exists but native binary missing)
 * 3. skip (native binary already present)
 *
 * Uses subprocess pattern (like integration.test.ts) with a test harness
 * that captures commands instead of executing them.
 */

import { describe, test, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, readdirSync, statSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Test harness script ──
// Replicates ensure-deps.mjs logic but captures commands instead of executing.
const HARNESS = `
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.argv[2];
const NATIVE_DEPS = ["better-sqlite3"];
const NATIVE_BINARIES = {
  "better-sqlite3": ["build", "Release", "better_sqlite3.node"],
};
const captured = [];

for (const pkg of NATIVE_DEPS) {
  const pkgDir = resolve(root, "node_modules", pkg);
  const binaryPath = resolve(pkgDir, ...NATIVE_BINARIES[pkg]);
  if (!existsSync(pkgDir)) {
    captured.push("install:" + pkg);
  } else if (!existsSync(binaryPath)) {
    captured.push("rebuild:" + pkg);
  }
}

console.log(JSON.stringify(captured));
`;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensure-deps-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHarness(root: string): string[] {
  const harnessPath = join(root, "_test-harness.mjs");
  writeFileSync(harnessPath, HARNESS, "utf-8");
  const result = spawnSync("node", [harnessPath, root], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return JSON.parse(result.stdout.trim());
}

// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for ensure-deps native binary detection
// ═══════════════════════════════════════════════════════════════════════

describe("ensure-deps: native binary detection (#206)", () => {
  test("runs npm install when package directory is missing", () => {
    const root = createTempRoot();
    // No node_modules at all
    const commands = runHarness(root);
    expect(commands).toEqual(["install:better-sqlite3"]);
  });

  test("runs npm rebuild when package dir exists but no native binary", () => {
    const root = createTempRoot();
    // Simulate ignore-scripts=true: directory exists, no native binary
    mkdirSync(join(root, "node_modules", "better-sqlite3"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("runs npm rebuild when build/Release exists but native binary is missing", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("runs npm rebuild when prebuilds exists but native binary is missing", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "node_modules", "better-sqlite3", "prebuilds"), { recursive: true });
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });

  test("skips when actual native binary exists", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "native-binary");
    const commands = runHarness(root);
    expect(commands).toEqual([]);
  });

  test("rebuild triggers even when package.json and JS files exist", () => {
    const root = createTempRoot();
    const pkgDir = join(root, "node_modules", "better-sqlite3");
    mkdirSync(pkgDir, { recursive: true });
    // JS files exist (npm installed the package) but no native binary
    writeFileSync(join(pkgDir, "package.json"), '{"name":"better-sqlite3"}', "utf-8");
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};", "utf-8");
    const commands = runHarness(root);
    expect(commands).toEqual(["rebuild:better-sqlite3"]);
  });
});

// ── Shared path to the real ensure-deps.mjs (used by ABI + codesign tests) ──
const ensureDepsAbsPath = join(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "ensure-deps.mjs");

// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for ABI cache validation (#148 follow-up)
// ═══════════════════════════════════════════════════════════════════════

// Subprocess harness that replicates ensureNativeCompat's decision logic
// using a simulated probe (binary is "valid" if content starts with "VALID").
// This avoids needing a real better-sqlite3 install in the temp dir.
const ABI_HARNESS = `
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginRoot = process.argv[2];
const abi = "137"; // arbitrary ABI value for testing — not tied to any real Node version
const skipProbe = process.argv.includes("--skip-probe");
const captured = [];

const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
const binaryPath = resolve(nativeDir, "better_sqlite3.node");
const abiCachePath = resolve(nativeDir, "better_sqlite3.abi" + abi + ".node");

function probeNative() {
  if (!existsSync(binaryPath)) return false;
  const buf = readFileSync(binaryPath);
  return buf.length >= 5 && buf.toString("utf-8", 0, 5) === "VALID";
}

function rebuildAndCache() {
  writeFileSync(binaryPath, "VALID-rebuilt-binary");
  captured.push("rebuilt");
  copyFileSync(binaryPath, abiCachePath);
  captured.push("cached");
}

if (!existsSync(nativeDir)) {
  console.log(JSON.stringify(captured));
  process.exit(0);
}

if (existsSync(abiCachePath)) {
  copyFileSync(abiCachePath, binaryPath);
  captured.push("cache-swap");
  if (skipProbe) {
    captured.push("cache-valid");
    console.log(JSON.stringify(captured));
    process.exit(0);
  }
  if (probeNative()) {
    captured.push("cache-valid");
    console.log(JSON.stringify(captured));
    process.exit(0);
  }
  captured.push("cache-invalid");
}

if (skipProbe) {
  captured.push(existsSync(binaryPath) ? "abi-cache-missing" : "binary-missing");
  rebuildAndCache();
  console.log(JSON.stringify(captured));
  process.exit(0);
}

if (existsSync(binaryPath) && probeNative()) {
  captured.push("probe-ok");
  copyFileSync(binaryPath, abiCachePath);
  captured.push("cached");
} else {
  captured.push(existsSync(binaryPath) ? "probe-fail" : "binary-missing");
  rebuildAndCache();
}

console.log(JSON.stringify(captured));
`;

describe("ensure-deps: ABI cache validation (#148 follow-up)", () => {
  function runAbiHarness(root: string, args: string[] = []): string[] {
    const harnessPath = join(root, "_abi-harness.mjs");
    writeFileSync(harnessPath, ABI_HARNESS, "utf-8");
    const result = spawnSync("node", [harnessPath, root, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    return JSON.parse(result.stdout.trim());
  }

  test("corrupted ABI cache: detects invalid binary, rebuilds, and re-caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // Valid binary on disk
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    // Corrupted cache (wrong ABI binary saved under current ABI label)
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "WRONG-abi115-binary");

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["cache-swap", "cache-invalid", "probe-fail", "rebuilt", "cached"]);
  });

  test("valid ABI cache: uses fast path without rebuild", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "VALID-cached-binary");

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["cache-swap", "cache-valid"]);
  });

  test("missing ABI cache with valid binary: probes and creates cache", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "VALID-original");
    // No abi137.node cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["probe-ok", "cached"]);
  });

  test("modern skip-probe path rebuilds when current ABI cache is missing", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "WRONG-stale-active-binary");
    // No abi137.node cache file: active binary alone is not proof on skip-probe runtimes.

    const actions = runAbiHarness(root, ["--skip-probe"]);
    expect(actions).toEqual(["abi-cache-missing", "rebuilt", "cached"]);
  });

  test("missing native binary in existing native dir: rebuilds and caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node on disk and no cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["binary-missing", "rebuilt", "cached"]);
  });

  test("missing ABI cache with incompatible binary: rebuilds and caches", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "WRONG-different-abi");
    // No cache file

    const actions = runAbiHarness(root);
    expect(actions).toEqual(["probe-fail", "rebuilt", "cached"]);
  });
  test("ABI rebuild uses npm from the running Node installation instead of ambient PATH", () => {
    const root = createTempRoot();
    const fakeBin = join(root, "fake-bin");
    const marker = join(root, "wrong-npm-ran");
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "not-a-native-binary");

    const fakeNpm = join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
    const fakeNpmSource =
      process.platform === "win32"
        ? '@echo off\r\n> "%FAKE_NPM_MARKER%" echo called\r\nexit /b 0\r\n'
        : '#!/bin/sh\nprintf called > "$FAKE_NPM_MARKER"\nexit 0\n';
    writeFileSync(fakeNpm, fakeNpmSource, "utf-8");
    if (process.platform !== "win32") chmodSync(fakeNpm, 0o755);

    const harness = `
import { existsSync } from "node:fs";
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
process.env.PATH = ${JSON.stringify(fakeBin)};
process.env.FAKE_NPM_MARKER = ${JSON.stringify(marker)};
ensureNativeCompat(${JSON.stringify(root)});
console.log(JSON.stringify({ wrongNpmRan: existsSync(${JSON.stringify(marker)}) }));
`;
    const harnessPath = join(root, "_runtime-pinned-rebuild.mjs");
    writeFileSync(harnessPath, harness, "utf-8");

    const result = spawnSync(process.execPath, [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ wrongNpmRan: false });
    expect(existsSync(marker)).toBe(false);
  });

  test("ABI probe uses the running Node executable instead of ambient PATH", () => {
    const root = createTempRoot();
    const fakeBin = join(root, "fake-bin");
    const marker = join(root, "wrong-node-ran");
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "not-a-native-binary");

    const fakeNode = join(fakeBin, process.platform === "win32" ? "node.cmd" : "node");
    const fakeNodeSource =
      process.platform === "win32"
        ? '@echo off\r\n> "%FAKE_NODE_MARKER%" echo called\r\nexit /b 0\r\n'
        : '#!/bin/sh\nprintf called > "$FAKE_NODE_MARKER"\nexit 0\n';
    writeFileSync(fakeNode, fakeNodeSource, "utf-8");
    if (process.platform !== "win32") chmodSync(fakeNode, 0o755);

    const harness = `
import { existsSync } from "node:fs";
const { ensureNativeCompat } = await import(${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))});
Object.defineProperty(process.versions, "node", { value: "20.0.0" });
process.env.PATH = ${JSON.stringify(fakeBin)};
process.env.FAKE_NODE_MARKER = ${JSON.stringify(marker)};
ensureNativeCompat(${JSON.stringify(root)});
console.log(JSON.stringify({ wrongNodeRan: existsSync(${JSON.stringify(marker)}) }));
`;
    const harnessPath = join(root, "_runtime-pinned-probe.mjs");
    writeFileSync(harnessPath, harness, "utf-8");

    const result = spawnSync(process.execPath, [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ wrongNodeRan: false });
    expect(existsSync(marker)).toBe(false);
  });

  test("corrupted cache with missing binary: early return after cache swap fails", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node on disk, only a corrupted cache
    writeFileSync(join(releaseDir, "better_sqlite3.abi137.node"), "WRONG-corrupt");

    const actions = runAbiHarness(root);
    // Cache swap copies corrupt → binaryPath, probe fails, then falls through.
    // binaryPath now exists (from the copy), so it won't hit the early return.
    // Instead it probes again, fails, and rebuilds.
    expect(actions).toEqual(["cache-swap", "cache-invalid", "probe-fail", "rebuilt", "cached"]);
  });

  test("graceful degradation: does not throw when probe and rebuild both fail", () => {
    // Exercise the real ensureNativeCompat on a fake plugin root where
    // better-sqlite3 exists but has no valid binary and npm rebuild will fail.
    // The outer try/catch must swallow all errors.
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "better_sqlite3.node"), "CORRUPT-binary");

    const harness = `
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
try {
  ensureNativeCompat(${JSON.stringify(root)});
  console.log(JSON.stringify({ threw: false }));
} catch (e) {
  console.log(JSON.stringify({ threw: true, error: e.message }));
}
`;
    const harnessPath = join(root, "_degrade-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ threw: false });
  });

  test("graceful degradation: missing native binary rebuild failure does not throw", () => {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    // No better_sqlite3.node — binary missing, rebuild will also fail

    const harness = `
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
try {
  ensureNativeCompat(${JSON.stringify(root)});
  console.log(JSON.stringify({ threw: false }));
} catch (e) {
  console.log(JSON.stringify({ threw: true, error: e.message }));
}
`;
    const harnessPath = join(root, "_missing-binary-degrade-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ threw: false });
  });
});

describe("ensure-deps: fast path skips a redundant cache swap (#1196)", () => {
  // Every hook call imports ensure-deps.mjs. Without a swap stamp the fast
  // path copied, codesigned and renamed the ABI cache over the active binary
  // on every call, so the active binary got a new inode each time.
  function setup() {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    const binaryPath = join(releaseDir, "better_sqlite3.node");
    const cachePath = join(releaseDir, `better_sqlite3.abi${process.versions.modules}.node`);
    writeFileSync(binaryPath, "ACTIVE-binary");
    writeFileSync(cachePath, "CACHED-binary");
    const harnessPath = join(root, "_swap-stamp-harness.mjs");
    writeFileSync(
      harnessPath,
      `
import { ensureNativeCompat } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
ensureNativeCompat(${JSON.stringify(root)});
`,
      "utf-8",
    );
    const run = () => {
      const result = spawnSync("node", [harnessPath], {
        encoding: "utf-8",
        timeout: 30_000,
        cwd: join(fileURLToPath(import.meta.url), "..", ".."),
      });
      if (result.error) throw result.error;
      return statSync(binaryPath).ino;
    };
    return { releaseDir, binaryPath, cachePath, run };
  }

  test("second call leaves the swapped-in binary untouched", () => {
    const { binaryPath, releaseDir, run } = setup();
    const first = run();
    expect(readFileSync(binaryPath, "utf-8")).toBe("CACHED-binary");
    expect(run()).toBe(first);
    expect(readdirSync(releaseDir).filter((f) => f.includes(".staging-"))).toEqual([]);
  });

  test("a changed ABI cache is swapped in again", () => {
    const { binaryPath, cachePath, run } = setup();
    const first = run();
    writeFileSync(cachePath, "NEWER-cached-binary");
    expect(run()).not.toBe(first);
    expect(readFileSync(binaryPath, "utf-8")).toBe("NEWER-cached-binary");
  });

  test("an active binary replaced from outside is swapped again", () => {
    const { binaryPath, run } = setup();
    run();
    writeFileSync(binaryPath, "REBUILT-elsewhere");
    run();
    expect(readFileSync(binaryPath, "utf-8")).toBe("CACHED-binary");
  });
});

describe("ensure-deps: ABI cache writes are temp+rename, never in place (#1193)", () => {
  // The active-binary swap got temp+rename in #587/#591; the writes that
  // PRODUCE the cache entries did not. Two hook processes starting together
  // can have one reading abiCachePath via copyFileSync while the other
  // truncates that same path — the reader gets a short or mixed file and then
  // renames it into the live slot. The portable, deterministic form of that
  // hazard: a reader that already holds the old entry open must still see it
  // whole after the seed, which only holds if the write replaced a directory
  // entry instead of rewriting the file under the reader.
  function setup() {
    const root = createTempRoot();
    const releaseDir = join(root, "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(releaseDir, { recursive: true });
    const binaryPath = join(releaseDir, "better_sqlite3.node");
    const cachePath = join(releaseDir, `better_sqlite3.abi${process.versions.modules}.node`);
    writeFileSync(binaryPath, "NEW-ACTIVE-binary");
    const harnessPath = join(root, "_seed-harness.mjs");
    writeFileSync(
      harnessPath,
      `
import { seedAbiCacheEntry } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
seedAbiCacheEntry(${JSON.stringify(cachePath)}, ${JSON.stringify(binaryPath)});
`,
      "utf-8",
    );
    const run = () => {
      const result = spawnSync("node", [harnessPath], {
        encoding: "utf-8",
        timeout: 30_000,
        cwd: join(fileURLToPath(import.meta.url), "..", ".."),
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`seedAbiCacheEntry harness failed: ${result.stderr}`);
    };
    return { releaseDir, binaryPath, cachePath, run };
  }

  test("a reader holding the previous entry open still reads it whole", () => {
    const { cachePath, run } = setup();
    writeFileSync(cachePath, "PREVIOUS-COMPLETE-ENTRY");
    // This is the concurrent reader: it opened the entry before the seed.
    const held = openSync(cachePath, "r");

    try {
      run();

      // The reader is never on a torn file — that is the property #1193 is
      // about, and it holds on every platform.
      const seenByReader = readFileSync(held, "utf-8");
      expect(["PREVIOUS-COMPLETE-ENTRY", "NEW-ACTIVE-binary"]).toContain(seenByReader);
      // Windows cannot replace a directory entry another handle holds open
      // (the seed's rename fails and is swallowed as best-effort), so only
      // where the replace is possible does the entry move on under the reader.
      if (process.platform !== "win32") {
        expect(readFileSync(cachePath, "utf-8")).toBe("NEW-ACTIVE-binary");
        expect(seenByReader).toBe("PREVIOUS-COMPLETE-ENTRY");
      }
    } finally {
      closeSync(held);
    }
  });

  test("the seed replaces the directory entry instead of rewriting in place", () => {
    const { cachePath, run } = setup();
    writeFileSync(cachePath, "PREVIOUS");
    const before = statSync(cachePath).ino;
    run();
    // rename() installs a new inode; an in-place copy keeps the old one.
    expect(statSync(cachePath).ino).not.toBe(before);
  });

  test("no staging file is left behind", () => {
    const { releaseDir, cachePath, run } = setup();
    writeFileSync(cachePath, "PREVIOUS");
    run();
    expect(readdirSync(releaseDir).filter((f) => f.includes(".staging-"))).toEqual([]);
  });

  test("a missing active binary is a no-op, not a truncated entry", () => {
    const { cachePath, run } = setup();
    writeFileSync(cachePath, "PREVIOUS");
    // Point the harness at a binary that is not there.
    const missing = join(cachePath, "..", "does-not-exist.node");
    const result = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))}).then(m => m.seedAbiCacheEntry(${JSON.stringify(cachePath)}, ${JSON.stringify(missing)}))`,
      ],
      { encoding: "utf-8", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    // The previous entry survives untouched instead of being clobbered.
    expect(readFileSync(cachePath, "utf-8")).toBe("PREVIOUS");
  });
});
// ═══════════════════════════════════════════════════════════════════════
// RED-GREEN tests for macOS codesign after binary copy (#SIGKILL fix)
// ═══════════════════════════════════════════════════════════════════════

// Subprocess harness that imports codesignBinary from ensure-deps.mjs and
// exercises it with mocked execSync to verify codesign behavior.
const CODESIGN_HARNESS = `
import { codesignBinary } from ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};

// Test: function must exist and be callable
if (typeof codesignBinary !== "function") {
  console.log(JSON.stringify({ error: "codesignBinary is not exported" }));
  process.exit(0);
}

const action = process.argv[2];
const fakePath = process.argv[3] || "/tmp/fake.node";

if (action === "check-export") {
  console.log(JSON.stringify({ exported: true }));
} else if (action === "run") {
  // Actually call codesignBinary — on macOS it will invoke codesign,
  // on non-macOS it should be a no-op. Either way it must not throw.
  try {
    codesignBinary(fakePath);
    console.log(JSON.stringify({ success: true, platform: process.platform }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
}
`;

describe("ensure-deps: codesignBinary macOS SIGKILL fix", () => {
  function runCodesignHarness(action: string, fakePath?: string): Record<string, unknown> {
    const root = createTempRoot();
    const harnessPath = join(root, "_codesign-harness.mjs");
    writeFileSync(harnessPath, CODESIGN_HARNESS, "utf-8");
    const args = [harnessPath, action];
    if (fakePath) args.push(fakePath);
    const result = spawnSync("node", args, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: join(fileURLToPath(import.meta.url), "..", ".."),
    });
    if (result.error) throw result.error;
    const stdout = result.stdout?.trim();
    if (!stdout) {
      throw new Error(`Harness produced no output. stderr: ${result.stderr}`);
    }
    return JSON.parse(stdout);
  }

  test("Test A: codesignBinary is exported as a function", () => {
    const out = runCodesignHarness("check-export");
    expect(out).toEqual({ exported: true });
  });

  test("Test B: codesignBinary does not throw (works on any platform)", () => {
    const out = runCodesignHarness("run", "/tmp/nonexistent.node");
    expect(out).toHaveProperty("success", true);
  });

  test("Test C: codesignBinary is safe when codesign target does not exist", () => {
    // On macOS, codesign will fail on a nonexistent file — must not throw.
    // On non-macOS, it should be a no-op.
    const out = runCodesignHarness("run", "/tmp/definitely-does-not-exist-12345.node");
    expect(out).toHaveProperty("success", true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Modern SQLite skip gate (#331 — Node v24 SIGSEGV prevention)
// ═══════════════════════════════════════════════════════════════════════

describe("ensure-deps: modern SQLite skip gate (#331)", () => {
  const MODERN_SQLITE_HARNESS = `
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Replicate hasModernSqlite() logic from ensure-deps.mjs
function hasModernSqlite() {
  if (typeof globalThis.Bun !== "undefined") return true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

const root = process.argv[2];
const result = {
  hasModernSqlite: hasModernSqlite(),
  nodeVersion: process.versions.node,
};

// If modern SQLite, ensureDeps and ensureNativeCompat should be no-ops.
// Verify by checking that no npm commands would be attempted.
if (result.hasModernSqlite) {
  // Simulate: even if node_modules is missing, ensureDeps should skip
  const pkgDir = resolve(root, "node_modules", "better-sqlite3");
  result.pkgDirExists = existsSync(pkgDir);
  result.wouldSkip = true;
} else {
  result.wouldSkip = false;
}

console.log(JSON.stringify(result));
`;

  test("hasModernSqlite returns correct value for current Node version", () => {
    const root = createTempRoot();
    const harnessPath = join(root, "_modern-sqlite-harness.mjs");
    writeFileSync(harnessPath, MODERN_SQLITE_HARNESS, "utf-8");
    const result = spawnSync("node", [harnessPath, root], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    const [major, minor] = process.versions.node.split(".").map(Number);
    const expected = major > 22 || (major === 22 && minor >= 5);
    expect(out.hasModernSqlite).toBe(expected);
  });

  test("ensureDeps is a no-op on modern runtimes (imports without side effects)", () => {
    // On Node >= 22.5 or Bun, importing ensure-deps.mjs should NOT attempt
    // any npm install/rebuild — the hasModernSqlite() gate early-returns.
    const [major, minor] = process.versions.node.split(".").map(Number);
    const isModern = major > 22 || (major === 22 && minor >= 5);
    if (!isModern) return; // skip on older Node

    const root = createTempRoot();
    // No node_modules at all — on old Node this would trigger npm install
    const harness = `
import ${JSON.stringify("file://" + ensureDepsAbsPath.replace(/\\/g, "/"))};
// If we got here without error, ensureDeps() and ensureNativeCompat()
// both returned early (no npm install attempted on empty dir).
console.log(JSON.stringify({ ok: true }));
`;
    const harnessPath = join(root, "_import-harness.mjs");
    writeFileSync(harnessPath, harness, "utf-8");
    const result = spawnSync("node", [harnessPath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: root,
    });
    if (result.error) throw result.error;
    const out = JSON.parse(result.stdout.trim());
    expect(out).toEqual({ ok: true });
  });
});

// ── better-sqlite3 binding self-heal (#408) ───────────────────────────────
//
// The missing-binding heal previously inlined ~30 lines of prebuild-install
// + npm install + stderr logic in `ensureDeps()`. PR #410 review: that
// block was a copy of the same logic in scripts/postinstall.mjs. The fix
// extracts both into scripts/heal-better-sqlite3.mjs and has each caller
// delegate. ABI-mismatch heal in ensureNativeCompat() is unrelated and
// must remain (regression-critical — guards #148, #203).

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

describe("ensure-deps: better-sqlite3 binding self-heal (#408)", () => {
  const ENSURE_DEPS_SRC = readFileSync(resolvePath(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "ensure-deps.mjs"), "utf-8");

  test("references the shared heal helper at scripts/heal-better-sqlite3.mjs", () => {
    // After dedupe the inline heal is gone — replaced by a reference to
    // scripts/heal-better-sqlite3.mjs. Accept either a static import or a
    // dynamic-import path: the helper is lazy-loaded so synthetic test
    // harnesses (e.g. tests/session-hooks-smoke) that don't ship `scripts/`
    // alongside `hooks/` don't crash the hook on load.
    const referencesHelperPath =
      /["']\.\.\/scripts\/heal-better-sqlite3(?:\.mjs)?["']/.test(ENSURE_DEPS_SRC) ||
      /scripts[\\/]heal-better-sqlite3\.mjs/.test(ENSURE_DEPS_SRC) ||
      /heal-better-sqlite3\.mjs/.test(ENSURE_DEPS_SRC);
    expect(referencesHelperPath).toBe(true);
    expect(ENSURE_DEPS_SRC).toContain("healBetterSqlite3Binding");
  });

  test("calls healBetterSqlite3Binding(...) inside the missing-binding branch", () => {
    // The else-if guarding against a missing native binary must invoke the
    // shared helper (not inline its own copy).
    const anchor = ENSURE_DEPS_SRC.indexOf("!existsSync(resolve(pkgDir, ...NATIVE_BINARIES[pkg]))");
    expect(anchor).toBeGreaterThan(-1);
    const end = ENSURE_DEPS_SRC.indexOf("\n/**\n * Probe-load better-sqlite3", anchor);
    const branch = ENSURE_DEPS_SRC.slice(anchor, end === -1 ? ENSURE_DEPS_SRC.length : end);
    expect(/healBetterSqlite3Binding\s*\(/.test(branch)).toBe(true);

    // Inline 3-layer heal must be gone — no `npm rebuild better-sqlite3`,
    // no direct `prebuild-install` resolve, no manual process.execPath
    // spawn here. The helper owns all of that now.
    expect(/\brebuild\s+better-sqlite3\b/.test(branch)).toBe(false);
    expect(/prebuild-install/.test(branch)).toBe(false);
    expect(/process\.execPath/.test(branch)).toBe(false);
  });

  test("ABI-mismatch rebuild path in ensureNativeCompat() remains intact", () => {
    // Regression guard — the ABI-mismatch heal (separate from #408's
    // missing-binding heal) MUST keep using `npm rebuild better-sqlite3
    // --ignore-scripts=false` for the cached-binary fallback flow.
    expect(/\brebuild\s+better-sqlite3\s+--ignore-scripts=false/.test(ENSURE_DEPS_SRC)).toBe(true);
    expect(/export function ensureNativeCompat\s*\(/.test(ENSURE_DEPS_SRC)).toBe(true);
    // The rebuild appears at least twice (skipProbe path + probe-failed path).
    const rebuildCount = (ENSURE_DEPS_SRC.match(/\brebuild\s+better-sqlite3\s+--ignore-scripts=false/g) || []).length;
    expect(rebuildCount).toBeGreaterThanOrEqual(2);
  });

  test("modern skip-probe branch treats missing ABI cache as rebuild-required", () => {
    const branchStart = ENSURE_DEPS_SRC.indexOf("if (skipProbe) {");
    expect(branchStart).toBeGreaterThan(-1);
    const probeStart = ENSURE_DEPS_SRC.indexOf("// Probe: try loading better-sqlite3", branchStart);
    expect(probeStart).toBeGreaterThan(branchStart);
    const branch = ENSURE_DEPS_SRC.slice(branchStart, probeStart);

    expect(branch).toContain("rebuild better-sqlite3 --ignore-scripts=false");
    // The branch must still SEED the cache (both exits), so a missing entry
    // does not force `npm rebuild` on every hook invocation. The write itself
    // moved into seedAbiCacheEntry() for the temp+rename treatment (#1193);
    // the invariant under test is the seeding, not the copy statement.
    expect(branch).toContain("seedAbiCacheEntry(abiCachePath, binaryPath)");
    expect(branch).not.toMatch(/if\s*\(\s*!\s*existsSync\(binaryPath\)\s*\)/);
    expect(branch).not.toContain("binding present");
  });

  // #1188 — the SIGSEGV the #331 fix was chasing came back wearing its clothes.
  // #331 moved the ABI probe from a throwaway child into the hook process to
  // stop the child from crashing. But a FAILED dlopen does not unmap the
  // library, and the very next statement on the failure path is an in-place
  // `npm rebuild better-sqlite3` that truncates and rewrites that same file —
  // so the bytes behind a live PROT_EXEC mapping were replaced and the next
  // access killed the host hook process. This is a source-level assertion on
  // purpose: reproducing a PROT_EXEC corruption SIGSEGV needs a real
  // ABI-mismatched .node and a Linux SIGSEGV, neither of which a portable
  // suite can arrange. What is portable, and what actually caused the crash,
  // is "does the compat check dlopen the addon in the process that may then
  // rewrite it".
  test("the compat check never dlopens better-sqlite3 in the process it may rebuild (#1188)", () => {
    expect(ENSURE_DEPS_SRC).not.toContain("createRequire");
    expect(ENSURE_DEPS_SRC).not.toContain("probeNativeInProcess");
    // The probe the skipProbe branch must use is the isolated child one.
    const branchStart = ENSURE_DEPS_SRC.indexOf("if (skipProbe) {");
    const probeStart = ENSURE_DEPS_SRC.indexOf("// Probe: try loading better-sqlite3", branchStart);
    const branch = ENSURE_DEPS_SRC.slice(branchStart, probeStart);
    expect(branch).toContain("probeNativeInChildProcess(pluginRoot)");
  });

  test("the child probe is pinned to process.execPath, not ambient PATH (#1105)", () => {
    const fnStart = ENSURE_DEPS_SRC.indexOf("function probeNativeInChildProcess");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = ENSURE_DEPS_SRC.slice(fnStart, fnStart + 600);
    expect(fn).toContain("execFileSync(process.execPath");
    expect(fn).not.toMatch(/execFileSync\(\s*["'`]node["'`]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Install failure backoff — a failed `npm install` must not be retried on
// every hook invocation (#1139, #1174: npm's Arborist can crash inside the
// plugin dir; offline / registry errors fail the same way). Without a
// backoff every hook call spawns a synchronous install that never converges.
// Runs the REAL ensure-deps.mjs against a fake `npm` on PATH.
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(process.platform === "win32")("ensure-deps: install failure backoff", () => {
  const MARKER = ".ensure-deps-better-sqlite3.install-state.json";

  function makePluginRoot(npmBody: string) {
    const root = createTempRoot();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "ensure-deps.mjs"), readFileSync(ensureDepsAbsPath, "utf-8"));
    writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"0.0.0"}');
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    const log = join(root, "npm-calls.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$*" >> "${log}"\n${npmBody}\n`);
    chmodSync(join(bin, "npm"), 0o755);
    const hookUrl = pathToFileURL(join(root, "hooks", "ensure-deps.mjs")).href;
    const run = () => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(hookUrl)})`], {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(r.status).toBe(0);
    };
    const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).length : 0);
    return { run, calls, marker: join(root, MARKER) };
  }

  test("a failed install is attempted once, then skipped on later hook calls", () => {
    const p = makePluginRoot(`echo "npm error Cannot read properties of null (reading 'edgesOut')" >&2; exit 1`);
    p.run();
    expect(p.calls()).toBe(1);
    expect(existsSync(p.marker)).toBe(true);
    const m = JSON.parse(readFileSync(p.marker, "utf-8"));
    expect(m.node).toBe(process.version);
    expect(m.error).toContain("edgesOut");
    p.run();
    p.run();
    expect(p.calls()).toBe(1);
  });

  test("an install that exits 0 but leaves the package missing also backs off", () => {
    const p = makePluginRoot("exit 0");
    p.run();
    p.run();
    expect(p.calls()).toBe(1);
  });

  test("retries after the backoff window expires", () => {
    const p = makePluginRoot("exit 1");
    p.run();
    const m = JSON.parse(readFileSync(p.marker, "utf-8"));
    writeFileSync(p.marker, JSON.stringify({ ...m, at: m.at - 2 * 60 * 60 * 1000 }));
    p.run();
    expect(p.calls()).toBe(2);
  });

  test("retries immediately under a different Node version", () => {
    const p = makePluginRoot("exit 1");
    p.run();
    const m = JSON.parse(readFileSync(p.marker, "utf-8"));
    writeFileSync(p.marker, JSON.stringify({ ...m, node: "v0.0.0-other" }));
    p.run();
    expect(p.calls()).toBe(2);
  });

  test("an in-flight install is not duplicated; a stale in-flight marker is ignored", () => {
    const p = makePluginRoot("exit 1");
    writeFileSync(p.marker, JSON.stringify({ at: Date.now(), node: process.version, pending: true }));
    p.run();
    expect(p.calls()).toBe(0);
    writeFileSync(p.marker, JSON.stringify({ at: Date.now() - 10 * 60 * 1000, node: process.version, pending: true }));
    p.run();
    expect(p.calls()).toBe(1);
  });

  test("a successful install clears the marker and stops further installs", () => {
    const p = makePluginRoot(`mkdir -p node_modules/better-sqlite3 && echo "{}" > node_modules/better-sqlite3/package.json`);
    writeFileSync(p.marker, JSON.stringify({ at: Date.now() - 2 * 60 * 60 * 1000, node: process.version, error: "old" }));
    p.run();
    expect(p.calls()).toBe(1);
    expect(existsSync(p.marker)).toBe(false);
    p.run();
    expect(p.calls()).toBe(1);
  });
});

// ── #863: cwd-safe native install (npm.cmd drops cwd under shell:true) ──
// Mirrors the start.mjs idiom absorbed with #861: npm's own CLI driven
// through node honors cwd with shell:false, where npm.cmd+shell:true resolved
// node_modules from C:\Windows and died on EPERM. Source-shape guard scoped
// to the install branch so the rebuild paths (which legitimately keep execSync)
// cannot satisfy the assertions.
describe("ensure-deps: cwd-safe native install (#863)", () => {
  const SRC = readFileSync(join(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "ensure-deps.mjs"), "utf-8");
  const installBranch = SRC.slice(SRC.indexOf("Package not installed at all"), SRC.indexOf("} else if (!existsSync(resolve(pkgDir"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("install runs npm's own CLI via node (shell:false honors cwd), not npm.cmd+shell:true", () => {
    expect(installBranch.length).toBeGreaterThan(0);
    expect(installBranch).toContain("npm-cli.js");
    expect(installBranch).toMatch(/execFileSync\(\s*process\.execPath/);
    expect(installBranch).not.toMatch(/execSync\([^)]*npm\.cmd[^)]*install/);
  });

  test("install failures still surface through the error marker, not a silent swallow", () => {
    expect(installBranch).toMatch(/writeInstallMarker\(pkg, \{ error:/);
  });
});
