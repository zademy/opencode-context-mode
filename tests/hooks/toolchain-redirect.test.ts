/**
 * The toolchain redirect: which commands get routed into the sandbox, and what
 * the suggestion says once they do.
 *
 * Two failure modes this file exists to prevent:
 *   1. A MISS — the command floods and nothing catches it. For a JS/TS repo
 *      that is `npm test` and `tsc`, which is most of the session.
 *   2. A FALSE POSITIVE — a bounded probe gets rewritten, or worse, a
 *      long-running `next dev` gets routed into a sandbox that waits for
 *      stdout that never comes.
 *
 * Windows is asserted explicitly rather than assumed: the same executable is
 * `npm` on POSIX and `npm.cmd` / `.\gradlew.bat` on Windows, and a matcher
 * that only knows the POSIX spelling routes nothing there.
 */

import { describe, it, expect } from "vitest";

import { matchFloodingToolchain, toolchainTailCommand, toolchainFilterHint } from "../../hooks/core/routing.mjs";

/** Convenience: the label, or null. */
const match = (cmd: string) => matchFloodingToolchain(cmd);

describe("matchFloodingToolchain — JVM (the original #38/#406 coverage)", () => {
  it.each(["gradle build", "./gradlew test", "mvn package", "./mvnw install", "sbt compile", "gradle"])("matches %s", (cmd) => {
    expect(match(cmd)).toBe("Build tool");
  });

  it("does not match a name that merely contains the tool", () => {
    expect(match("cat gradle-wrapper-config.json")).toBeNull();
    expect(match("mvnDocker ps")).toBeNull();
    expect(match("./gradlew-config")).toBeNull();
  });
});

describe("matchFloodingToolchain — Node / TypeScript", () => {
  it.each([
    "npm test",
    "npm t",
    "npm run test",
    "npm run build",
    "npm run lint",
    "npm run typecheck",
    "npm run check",
    "npm run tsc",
    // In a real JS project the script is usually namespaced. Requiring an
    // exact match would miss most of what actually runs.
    "npm run build:all",
    "npm run test:unit",
    "npm run lint:fix",
    "pnpm build:prod",
    "pnpm test",
    "pnpm run build",
    "yarn test",
    "yarn build",
    "bun test",
    "bun run build",
    "vitest",
    "vitest run",
    "jest --coverage",
    "playwright test",
    "tsc",
    "tsc --noEmit",
    "eslint .",
    "prettier --check .",
    "biome check .",
  ])("matches %s", (cmd) => {
    expect(match(cmd)).not.toBeNull();
  });

  // A flood guard that fires on every package-manager call is noise; the
  // routing block lists install as the sanctioned Bash use.
  it("leaves install alone", () => {
    expect(match("npm install")).toBeNull();
    expect(match("npm ci")).toBeNull();
    expect(match("pnpm add zod")).toBeNull();
    expect(match("npm install -g open-context-mode")).toBeNull();
  });

  // These never terminate. Routing them into a sandbox that collects stdout
  // would hang the turn instead of saving bytes.
  it("leaves long-running servers alone", () => {
    expect(match("npm run dev")).toBeNull();
    expect(match("next dev")).toBeNull();
    expect(match("next start")).toBeNull();
    expect(match("npm run watch")).toBeNull();
  });

  it("leaves bounded probes alone", () => {
    expect(match("npm --version")).toBeNull();
    expect(match("node --version")).toBeNull();
    expect(match("npm ls --depth=0")).toBeNull();
  });

  // Word-boundary guard: a prefix match would fire on unrelated tooling.
  it("does not match a longer executable that starts with the tool name", () => {
    expect(match("tsc-alias -p tsconfig.json")).toBeNull();
    expect(match("jest-explore-summary")).toBeNull();
    expect(match("cat tsc.md")).toBeNull();
    // A script whose name merely CONTAINS a keyword is not that script.
    expect(match("npm run rebuild-docs")).toBeNull();
    expect(match("npm run testing-notes")).toBeNull();
  });
});

describe("matchFloodingToolchain — Python, Rust, Go, make, docker", () => {
  it.each([
    "pytest",
    "pytest -q tests/",
    "python -m pytest",
    "mypy .",
    "ruff check .",
    "cargo build",
    "cargo test",
    "cargo clippy",
    "go build ./...",
    "go test ./...",
    "make",
    "make all",
    "docker build .",
    "docker compose build",
  ])("matches %s", (cmd) => {
    expect(match(cmd)).not.toBeNull();
  });

  it("labels a bare test runner as such", () => {
    expect(match("vitest")).toBe("Test runner");
    expect(match("pytest -q")).toBe("Test runner");
  });

  // `make` must not match inside `cmake`, and `go` not inside `google-chrome`.
  it("does not match a word that merely contains the tool name", () => {
    expect(match("cmake --build .")).toBeNull();
    expect(match("google-chrome --version")).toBeNull();
    expect(match("cargo-watch -w")).toBeNull();
  });

  it("leaves bounded go/cargo subcommands alone", () => {
    expect(match("go version")).toBeNull();
    expect(match("cargo --version")).toBeNull();
  });
});

describe("matchFloodingToolchain — Windows spellings", () => {
  it.each([
    "npm.cmd test",
    "npm.exe run build",
    "pnpm.cmd test",
    "yarn.cmd build",
    "bun.exe test",
    ".\\gradlew.bat test",
    ".\\mvnw.cmd package",
    ".\\sbt.bat compile",
    "gradlew.bat",
  ])("matches %s", (cmd) => {
    expect(match(cmd)).not.toBeNull();
  });

  it("still refuses the Windows spellings of a long-running script", () => {
    expect(match("npm.cmd run dev")).toBeNull();
    expect(match("npm.cmd install")).toBeNull();
  });
});

describe("matchFloodingToolchain — command position", () => {
  // The matcher runs against the whole command string, so it has to find the
  // tool after a chain separator and refuse to fire on a mention.
  it("matches a tool that appears after a chain separator", () => {
    expect(match("cd app && npm test")).not.toBeNull();
    expect(match("git status; pytest")).not.toBeNull();
  });

  it("does not match the tool name inside a quoted argument", () => {
    expect(match('echo "npm test" > /tmp/x')).toBeNull();
  });

  it("tolerates empty input", () => {
    expect(match("")).toBeNull();
    expect(matchFloodingToolchain(undefined)).toBeNull();
  });
});

describe("shell-aware suggestion text", () => {
  it("uses POSIX filters on a POSIX host", () => {
    expect(toolchainTailCommand("linux")).toContain("tail -30");
    expect(toolchainFilterHint("darwin")).toContain("grep -E");
  });

  // `tail` and `grep -E` do not exist in PowerShell or cmd. A suggestion that
  // fails to run teaches the model the redirect is broken.
  it("uses PowerShell filters on a Windows host", () => {
    expect(toolchainTailCommand("win32")).toContain("Select-Object -Last 30");
    expect(toolchainFilterHint("win32")).toContain("Select-String");
  });

  it("never suggests a POSIX-only tool on Windows", () => {
    expect(toolchainTailCommand("win32")).not.toContain("tail -");
    expect(toolchainFilterHint("win32")).not.toContain("grep -E");
  });

  it("defaults to the running platform when no override is given", () => {
    const expected = process.platform === "win32" ? "Select-Object" : "tail";
    expect(toolchainTailCommand()).toContain(expected);
  });
});
