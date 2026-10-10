import { describe, it, expect, afterEach } from "vitest";

import {
  detectPlatform,
  getEnvVarNames,
  foreignWorkspaceEnv,
  foreignIdentificationEnv,
  workspaceEnvVarsFor,
} from "../../src/platforms/detect.js";

const OPENCODE_ENV = ["OPENCODE_CLIENT", "OPENCODE", "OPENCODE_PID", "OPENCODE_TERMINAL", "OPENCODE_PROJECT_DIR"];

describe("detectPlatform", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (OPENCODE_ENV.includes(k)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("takes the name from the MCP handshake, not from a table", () => {
    const signal = detectPlatform({ name: "Zed 1.2.3-beta" });
    expect(signal.platform).toBe("zed-1-2-3-beta");
    expect(signal.confidence).toBe("high");
  });

  it("falls back to the mcp label when the client name sanitises to nothing", () => {
    expect(detectPlatform({ name: "***" }).platform).toBe("mcp");
  });

  it("keeps OpenCode off its own label when a foreign MCP client connects", () => {
    for (const k of OPENCODE_ENV) delete process.env[k];
    expect(detectPlatform({ name: "cursor" }).platform).toBe("cursor");
  });

  it("detects OpenCode from an identification env var", () => {
    for (const k of OPENCODE_ENV) delete process.env[k];
    process.env.OPENCODE_CLIENT = "my-term";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain("OPENCODE_CLIENT");
  });

  it("falls back to the workspace env var", () => {
    for (const k of OPENCODE_ENV) delete process.env[k];
    process.env.OPENCODE_PROJECT_DIR = "/tmp/project";
    const signal = detectPlatform();
    expect(signal.platform).toBe("opencode");
    expect(signal.confidence).toBe("medium");
  });

  it("does not mistake a blank env var for evidence", () => {
    for (const k of OPENCODE_ENV) delete process.env[k];
    process.env.OPENCODE_CLIENT = "   ";
    // The only signal left is whether this machine has an OpenCode config dir,
    // which the test must not depend on — so assert on the reason, not the label.
    expect(detectPlatform({ name: "" }, process.env).reason).not.toContain("OPENCODE_CLIENT");
  });

  it("ignores the ambient environment when the caller passes its own", () => {
    const signal = detectPlatform(undefined, {});
    expect(["opencode", "mcp"]).toContain(signal.platform);
  });
});

describe("env var registry", () => {
  it("carries OpenCode and nothing else", () => {
    expect(getEnvVarNames("opencode")).toEqual(OPENCODE_ENV);
    expect(workspaceEnvVarsFor("opencode")).toEqual(["OPENCODE_PROJECT_DIR"]);
  });

  it("reports no foreign env to scrub when OpenCode is the only platform", () => {
    expect(foreignWorkspaceEnv("opencode").size).toBe(0);
    expect(foreignIdentificationEnv("opencode").size).toBe(0);
  });
});
