import { describe, it, expect } from "vite-plus/test";

import { PLATFORM_ENV_VAR_TABLE, PLATFORM_TOOL_ALIASES } from "../../src/platform-identity.js";
import { PLATFORM_ENV_VARS } from "../../src/platforms/detect.js";

type Mirror = [string, string[]];

async function loadBundle(): Promise<{
  PLATFORM_ENV_VAR_TABLE: [string, { name: string; role: string }[]][];
  PLATFORM_TOOL_ALIASES: Record<string, string>;
}> {
  return await import("../../hooks/platform-identity.bundle.mjs");
}

describe("platform-identity: env vars are behaviour, tool aliases are data", () => {
  it("carries OpenCode and nothing else", () => {
    expect(PLATFORM_ENV_VAR_TABLE.map(([id]) => id)).toEqual(["opencode"]);
  });

  it("keeps the alias map — deleting a platform must not unlearn how clients spell tools", () => {
    expect(Object.keys(PLATFORM_TOOL_ALIASES).length).toBeGreaterThan(20);
    for (const native of ["read_file", "run_shell_command", "Shell", "PowerShell", "view", "shell"]) {
      expect(PLATFORM_TOOL_ALIASES, `${native} lost its canonical name`).toBeTruthy();
    }
  });

  it("every alias maps to a non-empty canonical name", () => {
    for (const [native, canonical] of Object.entries(PLATFORM_TOOL_ALIASES)) {
      expect(native.length, "native name must be non-empty").toBeGreaterThan(0);
      expect(canonical.length, `canonical name for "${native}" must be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe("detect.ts registry derives from the table", () => {
  it("PLATFORM_ENV_VARS keys match the table's env platforms, in order", () => {
    expect([...PLATFORM_ENV_VARS.keys()]).toEqual(PLATFORM_ENV_VAR_TABLE.map(([id]) => id));
  });

  it("every registry entry matches the table field by field", () => {
    for (const [platform, entries] of PLATFORM_ENV_VAR_TABLE) {
      expect(PLATFORM_ENV_VARS.get(platform) ?? []).toEqual(entries);
    }
  });
});

describe("the committed bundle carries the same data as the source table", () => {
  it("bundle PLATFORM_ENV_VAR_TABLE equals the source table (ordered)", async () => {
    const bundle = await loadBundle();
    expect(bundle.PLATFORM_ENV_VAR_TABLE).toEqual(PLATFORM_ENV_VAR_TABLE);
  });

  it("bundle PLATFORM_TOOL_ALIASES equals the source table's map", async () => {
    const bundle = await loadBundle();
    expect(bundle.PLATFORM_TOOL_ALIASES).toEqual({ ...PLATFORM_TOOL_ALIASES });
  });
});
