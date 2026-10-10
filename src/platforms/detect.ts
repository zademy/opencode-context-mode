/**
 * platforms/detect — two different questions, two different answers.
 *
 * "Is this OpenCode?" decides whether the plugin's hooks are the ones running.
 * The env vars in `PLATFORM_ENV_VAR_TABLE` are the only evidence; nothing about
 * a config directory counts, because the MCP server also runs there.
 *
 * "Which MCP client is this?" is only ever a label for the `platform` column
 * and for `doctor` output. It is taken from the `clientInfo.name` the client
 * sent during `initialize`, sanitized, and never consulted for anything on
 * disk.
 *
 * Storage is OpenCode's either way (see `opencodeConfigDir`), so no caller
 * needs to branch on the detected label to find a session dir.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PLATFORM_ENV_VAR_TABLE, type PlatformEnvEntry } from "../platform-identity.js";
import type { DetectionSignal, PlatformId } from "./types.js";

export type { PlatformEnvEntry } from "../platform-identity.js";

/** The label used when a client says nothing usable about itself. */
export const MCP_CLIENT_FALLBACK = "mcp";

/**
 * Env vars per platform. Tests iterate this to clear platform env vars
 * deterministically, and `resolveProjectDir({ strictPlatform })` reads the
 * workspace entry to build its cascade.
 */
export const PLATFORM_ENV_VARS: ReadonlyMap<PlatformId, readonly PlatformEnvEntry[]> = new Map(PLATFORM_ENV_VAR_TABLE);

/** Legacy `string[]` shape, in registry order. */
export function getEnvVarNames(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).map((e) => e.name);
}

/** Role=workspace env var names, in registry order. */
export function workspaceEnvVarsFor(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).filter((e) => e.role === "workspace").map((e) => e.name);
}

/**
 * Workspace env vars belonging to some platform other than the given one. With
 * OpenCode as the only platform this is empty, but the scrub it feeds is
 * cheap and keeps `resolveProjectDir` honest if a second entry returns.
 */
export function foreignWorkspaceEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [id, vars] of PLATFORM_ENV_VARS) {
    if (id === platform) continue;
    for (const v of vars) {
      if (v.role === "workspace") ban.add(v.name);
    }
  }
  return ban;
}

/** Identification env vars belonging to some platform other than the given one. */
export function foreignIdentificationEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [id, vars] of PLATFORM_ENV_VARS) {
    if (id === platform) continue;
    for (const v of vars) {
      if (v.role === "identification") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Normalize a client-supplied name into a stable slug: lower case, every run of
 * non-alphanumerics collapsed to a single dash. Observed, never curated —
 * `client-map.ts` is gone because a table we maintain cannot know what
 * "Zed 1.2.3-beta" calls itself next month.
 */
function sanitizeClientName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || MCP_CLIENT_FALLBACK;
}

/**
 * Resolve the client that is calling us.
 *
 * `clientInfo` from the MCP `initialize` handshake wins when present — the
 * client told us its name. Otherwise the env vars decide between OpenCode and
 * a generic MCP client, with the presence of `~/.config/opencode` as weak
 * evidence that this machine is an OpenCode one.
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }, env: NodeJS.ProcessEnv = process.env): DetectionSignal {
  if (clientInfo?.name?.trim()) {
    const label = sanitizeClientName(clientInfo.name);
    return {
      platform: label as PlatformId,
      confidence: "high",
      reason: `MCP clientInfo.name="${clientInfo.name}"`,
    };
  }

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    const hit = vars.find((v) => v.role === "identification" && env[v.name]?.trim());
    if (hit) {
      return { platform: platform as PlatformId, confidence: "high", reason: `${hit.name} is set` };
    }
  }

  const workspaceHit = [...PLATFORM_ENV_VARS.values()].flat().find((v) => v.role === "workspace" && env[v.name]?.trim());
  if (workspaceHit) {
    return { platform: "opencode", confidence: "medium", reason: `${workspaceHit.name} is set` };
  }

  if (existsSync(join(homedir(), ".config", "opencode"))) {
    return { platform: "opencode", confidence: "low", reason: "~/.config/opencode exists" };
  }

  return {
    platform: MCP_CLIENT_FALLBACK,
    confidence: "low",
    reason: "no client evidence — assuming a plain MCP client",
  };
}
