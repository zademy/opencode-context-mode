/**
 * Issues #2 / #3 / #4 — the three OpenCode retrieval journeys.
 *
 * #1 is the parent spec; #2, #3 and #4 are its independent slices. All three
 * ask for the same thing at different layers, so they share one file with one
 * set of journeys and three independent oracles. Nothing here is imported by
 * another ticket's check, and every oracle is hand-written from the fixtures
 * — never derived from the journey code that produces the answer.
 *
 *   Section 1 (#2) — OPEN_CONTEXT_MODE_CODE_ECHO_MAX=0 cuts returned bytes without
 *                    touching stdout, stderr or the error status.
 *   Section 2 (#3) — an exact lookup and an exact JSON record resolve in one
 *                    call; an absent identifier is an explicit not-found.
 *   Section 3 (#4) — a test-output diagnosis carries every failure and its
 *                    actionable detail; the count-only response fails the
 *                    same oracle, so the oracle has teeth.
 *
 * The boundary is the public MCP tool call, never a private formatter.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const repoRoot = resolve(__dirname, "..", "..");
const mcpEntry = resolve(repoRoot, "server.bundle.mjs");

// Absolute paths baked into the journey code so no test depends on the
// sandbox's working directory.
const SRC = resolve(repoRoot, "tests", "fixtures", "source-example.ts");
const OUT = resolve(repoRoot, "tests", "fixtures", "test-output.txt");
const ISSUES = resolve(repoRoot, "tests", "fixtures", "github-issues.json");

/** Quote an absolute path for safe use inside a bash command string. On
 *  Windows the fixture paths carry backslashes, which an unquoted
 *  interpolation turns into escape characters and mangles the path. */
const shq = (p: string): string => "'" + p.replace(/'/g, "'\\''") + "'";

// ── Server plumbing (same JSON-RPC shape as tests/core/echo-commands.test.ts)

type RpcResponse = {
  id?: number;
  error?: { message: string };
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
};

let rpcId = 100;
const echoOn = spawnServer({ OPEN_CONTEXT_MODE_CODE_ECHO_MAX: "2000" });
const echoOff = spawnServer({ OPEN_CONTEXT_MODE_CODE_ECHO_MAX: "0" });

function spawnServer(extraEnv: Record<string, string>): ChildProcess {
  return spawn("node", [mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OPEN_CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
      CLAUDE_PROJECT_DIR: repoRoot,
      ...extraEnv,
    },
  });
}

async function call(proc: ChildProcess, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const id = rpcId++;
  const response = await new Promise<RpcResponse | undefined>((res) => {
    let buffer = "";
    const onData = (d: Buffer) => {
      buffer += d.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as RpcResponse;
          if (parsed.id === id) {
            proc.stdout!.off("data", onData);
            clearTimeout(timer);
            res(parsed);
          }
        } catch {
          /* not a complete JSON-RPC line yet */
        }
      }
    };
    const timer = setTimeout(() => {
      proc.stdout!.off("data", onData);
      res(undefined);
    }, 30_000);
    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });

  expect(response?.error).toBeUndefined();
  return {
    isError: response?.result?.isError ?? false,
    text: response?.result?.content?.[0]?.text ?? "",
  };
}

async function initialize(proc: ChildProcess): Promise<void> {
  await new Promise<void>((res) => {
    const onData = (d: Buffer) => {
      proc.stdout!.off("data", onData);
      res();
    };
    proc.stdout!.on("data", onData);
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "opencode-retrieval-journeys", version: "1" },
        },
      }) + "\n",
    );
  });
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

beforeAll(async () => {
  await Promise.all([initialize(echoOn), initialize(echoOff)]);
}, 60_000);

afterAll(() => {
  for (const proc of [echoOn, echoOff]) proc.kill("SIGTERM");
});

// ── Journeys ────────────────────────────────────────────────────────────────

/** #2/#3 — locate an implementation by name: file, line and the excerpt. */
const LOOKUP = {
  language: "shell",
  code: `grep -n 'export function setupRoutes' ${shq(SRC)} | sed "s|^|${SRC}:|"
sed -n '146,153p' ${shq(SRC)}`,
};

/** #4 — every failed test, its diagnostic detail and the run summary. */
const DIAGNOSE = {
  language: "shell",
  code: `grep -vE '^ +✓|^ *$' ${shq(OUT)}`,
};

/** #4 negative case — failure names without any diagnostic detail. */
const NAMES_ONLY = {
  language: "shell",
  code: `grep -E '^ *✗ ' ${shq(OUT)}`,
};

/** #4 comparison baseline — hand the whole fixture back and search it. */
const WHOLE_FILE = { language: "shell", code: `cat ${shq(OUT)}` };

/** #2/#3 — one record out of github-issues.json by exact identifier. */
function jsonRecord(number: number) {
  return {
    path: ISSUES,
    language: "javascript",
    code: [
      'const fs = require("node:fs");',
      `const records = JSON.parse(fs.readFileSync(${JSON.stringify(ISSUES)}, "utf8"));`,
      `const wanted = ${number};`,
      "const hit = records.find((r) => r.number === wanted);",
      'console.log("source: tests/fixtures/github-issues.json");',
      "if (!hit) {",
      "  console.log(`NOT FOUND: no record with number=${wanted} (${records.length} records scanned)`);",
      "} else {",
      "  console.log(`number: ${hit.number}`);",
      "  console.log(`title: ${hit.title}`);",
      "  console.log(`author: ${hit.author.login}`);",
      "  console.log(`createdAt: ${hit.createdAt}`);",
      '  console.log(`labels: ${hit.labels.map((l) => l.name).join(", ")}`);',
      "}",
    ].join("\n"),
  };
}

const EXISTING_RECORD = 35855;
const MISSING_RECORD = 99999;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// ════════════════════════════════════════════════════════════════════════════
// #2 — OPEN_CONTEXT_MODE_CODE_ECHO_MAX=0
// ════════════════════════════════════════════════════════════════════════════

const REPEATS = 3;
const measurements: { journey: string; mode: string; runs: number[] }[] = [];

function record(journey: string, mode: string, returnedBytes: number) {
  let entry = measurements.find((m) => m.journey === journey && m.mode === mode);
  if (!entry) measurements.push((entry = { journey, mode, runs: [] }));
  entry.runs.push(returnedBytes);
}

describe("#2 — code echo opt-in returns fewer bytes and the same stdout", () => {
  const journeys = [
    ["implementation lookup", "open_ctx_execute", LOOKUP],
    ["test diagnosis", "open_ctx_execute", DIAGNOSE],
    ["exact JSON record", "open_ctx_execute_file", jsonRecord(EXISTING_RECORD)],
  ] as const;

  test.each(journeys)("%s — echoed bytes strictly greater, stdout byte-identical", async (_name, tool, args) => {
    for (let i = 0; i < REPEATS; i++) {
      const on = await call(echoOn, tool, { ...args });
      const off = await call(echoOff, tool, { ...args });
      expect(on.isError).toBe(false);
      expect(off.isError).toBe(false);
      record(_name, "echo=2000", bytes(on.text));
      record(_name, "echo=0", bytes(off.text));

      expect(bytes(on.text)).toBeGreaterThan(bytes(off.text));
      // The echo is a pure preamble: dropping it must leave stdout untouched.
      expect(on.text.endsWith(off.text)).toBe(true);
      expect(on.text.slice(0, on.text.length - off.text.length).length).toBeGreaterThan(0);
      // The dropped text is the agent's own code, never its answer.
      expect(off.text).not.toContain("```");
    }
  });

  test("a failing command keeps its stderr and error status in both modes", async () => {
    const args = { language: "shell", code: `echo "boom on stderr" >&2\nexit 3` };
    const on = await call(echoOn, "open_ctx_execute", args);
    const off = await call(echoOff, "open_ctx_execute", args);

    expect(on.isError).toBe(true);
    expect(off.isError).toBe(true);
    expect(on.text).toContain("boom on stderr");
    expect(off.text).toContain("boom on stderr");
    expect(on.isError).toBe(off.isError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #3 — exact repository and JSON queries, no recovery call
// ════════════════════════════════════════════════════════════════════════════

// Hand-written from tests/fixtures/source-example.ts. Not read back from the
// journey output — a journey that returned the wrong symbol still has to fail.
const EXPECTED_LOOKUP = {
  line: 146,
  signature: "export function setupRoutes(router: Router, service: UserService): Router {",
  excerpt: ['router.get("/users"', "ListUsersQuerySchema.parse(req.query)"],
};

describe("#3 — exact queries resolve in one call, absent ones say so", () => {
  test("implementation lookup returns the symbol, its location and its body", async () => {
    const { text } = await call(echoOff, "open_ctx_execute", LOOKUP);

    expect(text).toContain(`${EXPECTED_LOOKUP.line}:`);
    expect(text).toContain(EXPECTED_LOOKUP.signature);
    for (const line of EXPECTED_LOOKUP.excerpt) expect(text).toContain(line);
    // Attribution to the file it was read from, not just a line number.
    expect(text).toContain("source-example.ts");
  });

  test("exact JSON record returns the requested fields with a source reference", async () => {
    const { text } = await call(echoOff, "open_ctx_execute_file", jsonRecord(EXISTING_RECORD));

    expect(text).toContain("source: tests/fixtures/github-issues.json");
    expect(text).toContain("number: 35855");
    expect(text).toContain("title: Bug: ViewTransition onExit cleanup not called on unmount");
    expect(text).toContain("author: rickhanlonii");
    expect(text).toContain("createdAt: 2026-02-21T16:18:35Z");
    expect(text).toContain("labels: Status: Unconfirmed");
    expect(text).not.toContain("NOT FOUND");
  });

  test("a missing identifier is an explicit not-found, never a silent success", async () => {
    const { text, isError } = await call(echoOff, "open_ctx_execute_file", jsonRecord(MISSING_RECORD));

    expect(text).toContain(`NOT FOUND: no record with number=${MISSING_RECORD}`);
    expect(text).toContain("20 records scanned");
    // Nothing is invented for the identifier that was not there.
    expect(text).not.toContain("title:");
    expect(isError).toBe(false);
  });

  test("the whole-input-plus-retrieval strategy costs more returned bytes", async () => {
    const whole = await call(echoOff, "open_ctx_execute", {
      language: "shell",
      code: `cat ${shq(ISSUES)}`,
    });
    const wholeBytes = bytes(whole.text);
    const focused = await call(echoOff, "open_ctx_execute_file", jsonRecord(EXISTING_RECORD));
    const focusedBytes = bytes(focused.text);

    record("json: whole file", "echo=0", wholeBytes);
    record("json: exact record", "echo=0", focusedBytes);
    expect(focusedBytes).toBeLessThan(wholeBytes / 10);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #4 — complete test-failure diagnostics
// ════════════════════════════════════════════════════════════════════════════

// Hand-written from tests/fixtures/test-output.txt. This is the oracle: the
// journey code is never asked what it should have reported.
const EXPECTED_FAILURES = [
  {
    file: "src/components/UserList.test.tsx",
    test: "handles empty state",
    detail: ['expected: "No users found"', "received: undefined"],
  },
  {
    file: "src/components/DataGrid.test.tsx",
    test: "filters with complex queries",
    detail: ["TypeError: Cannot read properties of null (reading 'filter')", "DataGrid.tsx:89:23"],
  },
  {
    file: "src/api/trpc/routers/user.test.ts",
    test: "updates user role",
    detail: [
      'Expected: { role: "admin", updatedAt: expect.any(Date) }',
      'Received: { role: "admin", updatedAt: null }',
      "user.test.ts:89:18",
    ],
  },
  {
    file: "src/lib/email.test.ts",
    test: "sends password reset email",
    detail: ["Error: Resend API returned 429: Rate limit exceeded"],
  },
];

const EXPECTED_SUMMARY = ["Test Files  4 failed | 26 passed (30)", "Tests       4 failed | 108 passed (112)"];

/** Missing facts. Empty means the report is complete. */
function omissions(report: string): string[] {
  const missing: string[] = [];
  for (const f of EXPECTED_FAILURES) {
    if (!report.includes(f.file)) missing.push(`file ${f.file}`);
    if (!report.includes(f.test)) missing.push(`test ${f.test}`);
    for (const line of f.detail) if (!report.includes(line)) missing.push(`${f.test} → ${line}`);
  }
  for (const line of EXPECTED_SUMMARY) if (!report.includes(line)) missing.push(`summary ${line}`);
  return missing;
}

describe("#4 — a test-output diagnosis is complete or it is not a diagnosis", () => {
  test("every failed test, its diagnostic detail and the summary are present", async () => {
    const { text } = await call(echoOff, "open_ctx_execute", DIAGNOSE);
    expect(omissions(text)).toEqual([]);
    // Attribution to the fixture the diagnosis came from.
    expect(text).toContain("✗ src/components/DataGrid.test.tsx");
  });

  test("omitting a failure makes the check fail — the oracle has teeth", async () => {
    const { text } = await call(echoOff, "open_ctx_execute", NAMES_ONLY);

    // Names and summary survive; every actionable detail is gone.
    expect(omissions(text)).not.toEqual([]);
    expect(omissions(text)).toContain('handles empty state → expected: "No users found"');
    expect(omissions(text)).toContain("sends password reset email → Error: Resend API returned 429: Rate limit exceeded");
    // Smaller, and still not a usable diagnosis — never a savings win.
    expect(bytes(text)).toBeLessThan(bytes(await call(echoOff, "open_ctx_execute", DIAGNOSE).then((r) => r.text)));
  });

  test("complete diagnosis returns fewer bytes than the whole fixture", async () => {
    const { text } = await call(echoOff, "open_ctx_execute", DIAGNOSE);
    const whole = await call(echoOff, "open_ctx_execute", WHOLE_FILE);

    record("tests: whole fixture", "echo=0", bytes(whole.text));
    record("tests: complete diagnosis", "echo=0", bytes(text));

    expect(bytes(text)).toBeLessThan(bytes(whole.text));
    expect(omissions(whole.text)).toEqual([]); // both complete; the whole file just costs more
  });

  test("reading the fixture is not reported as a passing test run", async () => {
    const { isError, text } = await call(echoOff, "open_ctx_execute", WHOLE_FILE);

    // The command succeeded — the fixture records failures. Say which.
    expect(isError).toBe(false);
    expect(text).toContain("Test Files  4 failed | 26 passed (30)");
    expect(text).toContain("Tests       4 failed | 108 passed (112)");
  });
});

afterAll(() => {
  if (process.env.CM_PRINT_MEASUREMENTS) {
    for (const m of measurements) {
      // oxlint-disable-next-line no-console
      console.log(`MEASUREMENT ${m.journey} [${m.mode}] returned bytes: ${m.runs.join(", ")}`);
    }
  }
});
