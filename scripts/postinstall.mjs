#!/usr/bin/env node
/**
 * postinstall — cross-platform post-install tasks
 *
 * 1. Windows global install: fix broken bin→node_modules path
 *    when nvm4w places the shim and node_modules in different directories.
 *    Creates a directory junction so npm's %~dp0\node_modules\... resolves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { healBetterSqlite3Binding } from "./heal-better-sqlite3.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

// ── -2. Issue #564 — Linux SIGSEGV class hard-fail (v1.0.132) ────────
// On Linux + Node < 22.5 + no Bun, better-sqlite3's native addon is
// vulnerable to V8 calling `madvise(MADV_DONTNEED)` on memory ranges
// that overlap the addon's `.got.plt` section, corrupting resolved
// symbol addresses and causing sporadic SIGSEGV (1-4/hour) — see
// https://github.com/nodejs/node/issues/62515 and our internal #564.
//
// node:sqlite (built-in, no native addon, no .got.plt to corrupt) ships
// from Node 22.5 onward — that is the contract `hasModernSqlite()` in
// src/db-base.ts encodes. Six prior fixes (#228, #331, #461, #540,
// #551, #556) silently assumed users had Node >= 22.5 on Linux; #564
// is the second confirmed report (after #556) of the same SIGSEGV
// class on Node 20.
//
// The architect mandate for v1.0.132 is HARD-FAIL, not warn-then-
// degrade. `engines.node >= 22.5.0` in package.json is cosmetic under
// the default npm `engine-strict=false`, so the contract has to be
// enforced HERE — preinstall/postinstall is the only place that can
// `process.exit(1)` across npm/pnpm/yarn.
//
// Linux + Bun is allowed through (bun:sqlite sidesteps better-sqlite3
// entirely). Non-Linux platforms are unaffected by the madvise bug
// and pass through unchanged.
{
  const isLinux = process.platform === "linux";
  const hasBun = typeof globalThis.Bun !== "undefined" || typeof process.versions.bun === "string";
  const [majStr, minStr] = (process.versions.node ?? "0.0.0").split(".");
  const major = Number(majStr);
  const minor = Number(minStr);
  const hasModernNode = Number.isFinite(major) && Number.isFinite(minor) && (major > 22 || (major === 22 && minor >= 5));
  if (isLinux && !hasBun && !hasModernNode) {
    process.stderr.write(
      "\n" +
        "open-context-mode: install aborted\n" +
        "  Linux + Node " +
        (process.versions.node ?? "?") +
        " is unsupported.\n" +
        "  open-context-mode requires Node.js >= 22.5 (or Bun) on Linux to avoid the\n" +
        "  V8 madvise(MADV_DONTNEED) SIGSEGV affecting better-sqlite3 (1-4/hour).\n" +
        "  Tracking: https://github.com/nodejs/node/issues/62515\n" +
        "           https://github.com/mksglu/open-context-mode/issues/564\n" +
        "\n" +
        "  Fix: upgrade Node (recommended)\n" +
        "    nvm install 22.5 && nvm use 22.5\n" +
        "    npm install -g open-context-mode\n" +
        "\n" +
        "  Or: run under Bun\n" +
        "    curl -fsSL https://bun.sh/install | bash\n" +
        "    bun add -g open-context-mode\n" +
        "\n",
    );
    process.exit(1);
  }
}

/**
 * True when running as a real `npm install -g open-context-mode`. We use this
 * to keep contributors' local `npm install` runs from rewriting their HOME's
 * Claude Code registry (would be very surprising during dev).
 *
 * Heuristic: npm sets `npm_config_global=true` for global installs AND the
 * package directory has no nearby `.git` (a contributor's clone always
 * does). Both signals must agree.
 */
function isGlobalInstall() {
  if (process.env.npm_config_global !== "true") return false;
  // Walk up a few levels looking for .git — contributors always have one.
  let dir = pkgRoot;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, ".git"))) return false;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

/**
 * Validate that a path is safe to interpolate into a cmd.exe command.
 * Rejects characters that could enable command injection via cmd.exe.
 */
function isSafeWindowsPath(p) {
  return !/[&|<>"^%\r\n]/.test(p);
}

// ── 2. Windows global install — nvm4w junction fix ───────────────────
// npm's .cmd shim resolves modules via %~dp0\node_modules\<pkg>\...
// On nvm4w the shim lives at C:\nvm4w\nodejs\ but node_modules is at
// C:\Users\<USER>\AppData\Roaming\npm\node_modules\. The relative path
// breaks because they're on different prefixes.
//
// Fix: detect the mismatch and create a directory junction so the shim
// can reach us through the expected relative path.

if (process.platform === "win32" && process.env.npm_config_global === "true") {
  try {
    // npm prefix is where both the .cmd shims and node_modules live
    // Use npm_config_prefix env (set during install) or fall back to `npm config get prefix`
    // Note: `npm bin -g` was removed in npm v9+, so we use prefix instead
    const prefix =
      process.env.npm_config_prefix || execSync("npm config get prefix", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

    const actualPkgDir = pkgRoot;

    // npm's .cmd shim uses %~dp0\node_modules\<pkg>\... to find the entry point.
    // On nvm4w, stale shims at C:\nvm4w\nodejs\ may exist alongside correct ones
    // at the npm prefix. We create junctions at ALL known shim locations.
    const shimDirs = new Set([prefix]);

    // Detect stale shim locations via `where` command
    try {
      const whereOutput = execSync("where open-context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("open-context-mode.cmd")) {
          shimDirs.add(dirname(line));
        }
      }
    } catch {
      /* where may fail if not installed yet */
    }

    for (const shimDir of shimDirs) {
      const expectedPkgDir = join(shimDir, "node_modules", "open-context-mode");

      if (resolve(expectedPkgDir).toLowerCase() !== resolve(actualPkgDir).toLowerCase() && !existsSync(expectedPkgDir)) {
        const expectedNodeModules = join(shimDir, "node_modules");
        if (!existsSync(expectedNodeModules)) {
          mkdirSync(expectedNodeModules, { recursive: true });
        }

        // Create directory junction (no admin privileges needed on Windows 10+)
        // Validate paths to prevent cmd.exe injection via shell metacharacters
        if (!isSafeWindowsPath(expectedPkgDir) || !isSafeWindowsPath(actualPkgDir)) {
          console.warn(`  open-context-mode: skipping junction — path contains unsafe characters`);
        } else {
          execSync(`mklink /J "${expectedPkgDir}" "${actualPkgDir}"`, {
            shell: "cmd.exe",
            stdio: "pipe",
          });
          console.log(`\n  open-context-mode: created junction for nvm4w compatibility`);
          console.log(`    ${expectedPkgDir} → ${actualPkgDir}\n`);
        }
      }
    }

    // Also fix stale shims that reference old bin entry (build/cli.js → cli.bundle.mjs)
    try {
      const whereOutput = execSync("where open-context-mode.cmd", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      for (const line of whereOutput.split(/\r?\n/)) {
        if (line.endsWith("open-context-mode.cmd")) {
          const content = readFileSync(line, "utf-8");
          if (content.includes("build\\cli.js") || content.includes("build/cli.js")) {
            // Rewrite stale shim to use cli.bundle.mjs
            const fixed = content.replace(/build[\\\/]cli\.js/g, "cli.bundle.mjs");
            writeFileSync(line, fixed);
            console.log(`  open-context-mode: fixed stale shim at ${line}`);
          }
        }
      }
    } catch {
      /* best effort */
    }
  } catch {
    // Best effort — don't block install. User can use npx as fallback.
  }
}

// ── 3. Native binding self-heal — better-sqlite3 (#408) ──────────────
// On Windows, `npm rebuild` falls through to node-gyp without MSVC; bypass
// that by spawning prebuild-install directly. Cross-platform safety net —
// the binding can also go missing on macOS/Linux when prebuilds are stale
// or the install was interrupted.
//
// Logic lives in scripts/heal-better-sqlite3.mjs.
try {
  healBetterSqlite3Binding(pkgRoot);
} catch {
  /* best effort — don't block install */
}
