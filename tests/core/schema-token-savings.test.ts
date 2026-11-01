/**
 * Schema token savings (SPEC Point 2).
 *
 * The model receives ten open_ctx_* tools on every request, and two of those
 * payloads carry prose: the tool-level `description` (what the tool is for,
 * shaped by ADR-0002) and the `description` fields nested inside
 * `inputSchema` (what each PARAMETER means). The two are not
 * interchangeable — the schema layer is how the model learns that `language`
 * picks a runtime, that `intent` picks the search mode, that `commands`
 * differs from `code` — so the schema layer cannot simply be dropped.
 *
 * What this suite pins:
 *
 *   1. The mechanical rule that decides which schema descriptions are
 *      redundant with the tool's own prose (src/util/schema-token-savings.ts).
 *   2. That BOTH serving paths — the MCP `tools/list` response and the v2
 *      native tool registry — drop the JSON-Schema dialect URI (`$schema`).
 *   3. That the tool-level prose is never touched: byte-identical before and
 *      after the schema shrinks.
 *   4. That the served tool array still parses and every tool still carries a
 *      valid `inputSchema` with its `properties` intact.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// The v2 path builds its schema with the "zod/v4" entry point (see
// src/platforms/opencode/plugin.ts) — a DIFFERENT module instance than
// the package root, so a schema built with the root import cannot be
// converted. Import the same entry point the plugin imports.
import z from "zod/v4";

// The MCP server opens the stdio transport when it is imported, so the
// suite imports it with the embedded-plugin flag set: the tools/list
// handler is then driven over an in-memory transport instead of a pipe.
// The flag is restored immediately after the import so it cannot leak
// into another test file sharing the worker.
const previousEmbedded = process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
const { server, REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
if (previousEmbedded === undefined) delete process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
else process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = previousEmbedded;
import { zodShapeToJsonSchema } from "../../src/platforms/opencode/plugin.js";
import { zod3ShapeToV4 } from "../../src/platforms/opencode/zod3tov4.js";
import { isDescriptionCoveredByProse, slimToolSchema } from "../../src/util/schema-token-savings.js";

/** The slice of JSON Schema this suite inspects. */
type SchemaNode = {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [key: string]: unknown;
};

type ServedTool = {
  name: string;
  description?: string;
  inputSchema: SchemaNode;
};

/** The prose a tool was registered with — the pre-transform value. */
function registeredProse(name: string): string {
  const registered = REGISTERED_CTX_TOOLS.find((tool) => tool.name === name);
  return String(registered?.config.description ?? "");
}

/** The zod shape a tool was registered with. */
function registeredShape(name: string): Record<string, unknown> {
  const registered = REGISTERED_CTX_TOOLS.find((tool) => tool.name === name);
  const inputSchema = registered?.config.inputSchema as { shape?: unknown; _def?: { shape?: unknown } } | undefined;
  if (typeof inputSchema?.shape === "object" && inputSchema.shape !== null) {
    return inputSchema.shape as Record<string, unknown>;
  }
  if (typeof inputSchema?._def?.shape === "function") {
    return (inputSchema._def.shape as () => Record<string, unknown>)();
  }
  return {};
}

/** Every `description` string anywhere in a schema tree. */
function collectDescriptions(node: SchemaNode, out: string[] = []): string[] {
  if (typeof node.description === "string") out.push(node.description);
  for (const child of Object.values(node.properties ?? {})) {
    collectDescriptions(child, out);
  }
  if (node.items) collectDescriptions(node.items, out);
  return out;
}

// ─────────────────────────────────────────────────────────────
// The rule — "the prose covers it"
// ─────────────────────────────────────────────────────────────
describe("isDescriptionCoveredByProse", () => {
  it("covers a description that repeats the tool's own prose", () => {
    expect(
      isDescriptionCoveredByProse(
        "Label for this URL's indexed content",
        "Each request's URL content is indexed under its own source label.",
      ),
    ).toBe(true);
  });

  it("does not cover a description that explains a parameter the prose never mentions", () => {
    expect(
      isDescriptionCoveredByProse(
        "Max execution time in MILLISECONDS — timeoutMs: 120000 is two minutes.",
        "Run code in a sandboxed subprocess.",
      ),
    ).toBe(false);
  });

  it("does not cover a description that names a word the prose never uses", () => {
    expect(isDescriptionCoveredByProse("Filter by source", "Run code in a sandbox.")).toBe(false);
  });

  it("does not cover a description carrying a contract the prose never states", () => {
    // "MUST" is a contract keyword: common words, new rule. Not redundant.
    expect(isDescriptionCoveredByProse("MUST be true. Destructive operation.", "Run code in a sandbox.")).toBe(false);
  });

  it("covers a description whose contract the prose states too", () => {
    expect(isDescriptionCoveredByProse("MUST be true. Destructive operation.", "DESTRUCTIVE: a destructive operation. MUST be true.")).toBe(
      true,
    );
  });

  it("matches a word the prose only spells with a different ending", () => {
    // "fetch" is covered by "fetches" — the ending differs by two characters.
    expect(isDescriptionCoveredByProse("URL to fetch", "Fetches URL content.")).toBe(true);
    // "run" and "runtime" differ by more — different words, no match.
    expect(isDescriptionCoveredByProse("Runtime language", "Run code in a sandbox.")).toBe(false);
  });

  it("covers nothing when the prose is empty", () => {
    expect(isDescriptionCoveredByProse("URL to fetch", "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// slimToolSchema — what the rule does to a schema tree
// ─────────────────────────────────────────────────────────────
describe("slimToolSchema", () => {
  it("strips a schema description that duplicates its tool's prose", () => {
    const schema = {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
    };
    const slimmed = slimToolSchema(schema, "Fetches URL content.");
    expect(slimmed.properties?.url?.description).toBeUndefined();
    expect(slimmed.properties?.url?.type).toBe("string");
  });

  it("keeps a schema description that explains a parameter the prose does NOT cover", () => {
    const schema = {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Max execution time in MILLISECONDS." },
      },
    };
    const slimmed = slimToolSchema(schema, "Run code in a sandboxed subprocess.");
    expect(slimmed.properties?.timeoutMs?.description).toBe("Max execution time in MILLISECONDS.");
  });

  it("drops $schema at every depth", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        requests: {
          type: "array",
          items: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      },
    };
    const slimmed = slimToolSchema(schema, "Fetches URL content.");
    expect(slimmed).not.toHaveProperty("$schema");
    expect(slimmed.properties?.requests?.items).not.toHaveProperty("$schema");
  });

  it("keeps every other key and does not mutate its input", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { url: { type: "string", description: "Milliseconds to wait." } },
      required: ["url"],
      additionalProperties: false,
    };
    const slimmed = slimToolSchema(schema, "Fetches URL content.");
    expect(slimmed.required).toEqual(["url"]);
    expect(slimmed.additionalProperties).toBe(false);
    expect(slimmed.properties?.url?.description).toBe("Milliseconds to wait.");
    // Input untouched — the caller still holds the original tree.
    expect(schema).toHaveProperty("$schema");
    expect(schema.properties.url.description).toBe("Milliseconds to wait.");
  });

  it("leaves a non-object value alone", () => {
    expect(slimToolSchema("not a schema", "prose")).toBe("not a schema");
    expect(slimToolSchema(null, "prose")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────
// MCP path — the tools/list response the model receives
// ─────────────────────────────────────────────────────────────
describe("MCP path — tools/list", () => {
  let served: { tools: ServedTool[] };

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "schema-token-savings-test", version: "1.0.0" });
    await client.connect(clientTransport);
    served = (await client.listTools()) as unknown as { tools: ServedTool[] };
    await client.close();
    await server.close();
  });

  afterAll(() => {
    // Nothing to tear down — the in-memory transport pair is process-local.
  });

  it("serves all ten open_ctx_* tools", () => {
    expect(served.tools).toHaveLength(10);
    expect(served.tools.map((tool) => tool.name)).toContain("open_ctx_execute");
    expect(served.tools.map((tool) => tool.name)).toContain("open_ctx_search");
  });

  it("serves a tool array that parses", () => {
    const round = JSON.parse(JSON.stringify(served));
    expect(round.tools).toHaveLength(10);
  });

  it("leaves every tool-level prose description byte-identical to the registered one", () => {
    for (const tool of served.tools) {
      const registered = registeredProse(tool.name);
      expect(registered.length).toBeGreaterThan(0);
      expect(tool.description).toBe(registered);
      expect(Buffer.byteLength(tool.description ?? "", "utf8")).toBe(Buffer.byteLength(registered, "utf8"));
    }
  });

  it("serves no $schema on any tool", () => {
    for (const tool of served.tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$schema");
    }
  });

  it("serves a valid object schema with its properties intact for every tool", () => {
    for (const tool of served.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(registeredShape(tool.name)).sort());
    }
  });

  it("drops the parameter descriptions the prose already covers", () => {
    const fetch = served.tools.find((tool) => tool.name === "open_ctx_fetch_and_index");
    const requests = fetch?.inputSchema.properties?.requests?.items?.properties;
    // The prose already says "Fetches URL content" and "Each request indexed
    // under its own source label".
    expect(requests?.url?.description).toBeUndefined();
    expect(requests?.source?.description).toBeUndefined();
  });

  it("keeps the parameter descriptions the prose never states", () => {
    const execute = served.tools.find((tool) => tool.name === "open_ctx_execute");
    const properties = execute?.inputSchema.properties;
    expect(properties?.code?.description).toContain("console.log");
    expect(properties?.timeoutMs?.description).toContain("MILLISECONDS");

    const search = served.tools.find((tool) => tool.name === "open_ctx_search");
    const searchProperties = search?.inputSchema.properties;
    // The prose never states the sort modes or the default result count.
    expect(searchProperties?.sort?.description).toContain("relevance");
    expect(searchProperties?.limit?.description).toContain("default");
  });
});

// ─────────────────────────────────────────────────────────────
// v2 native path — the schema the OpenCode 2.x host receives
// ─────────────────────────────────────────────────────────────
describe("v2 native path — zodShapeToJsonSchema", () => {
  it("drops $schema from the schema the host receives", () => {
    const schema = zodShapeToJsonSchema({ language: z.string().describe("Runtime language") }, "Languages: javascript, shell.");
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.type).toBe("object");
  });

  it("strips a description the prose covers and keeps one it does not", () => {
    const covered = zodShapeToJsonSchema({ url: z.string().describe("URL to fetch") }, "Fetches URL content.");
    expect((covered.properties as Record<string, SchemaNode>).url.description).toBeUndefined();

    const informative = zodShapeToJsonSchema(
      { timeoutMs: z.number().describe("Max execution time in MILLISECONDS.") },
      "Run code in a sandboxed subprocess.",
    );
    expect((informative.properties as Record<string, SchemaNode>).timeoutMs.description).toBe("Max execution time in MILLISECONDS.");
  });

  it("serves a valid object schema with its properties intact for every registered tool", () => {
    for (const registered of REGISTERED_CTX_TOOLS) {
      const shape = registeredShape(registered.name);
      const schema = zodShapeToJsonSchema(zod3ShapeToV4(shape), String(registered.config.description ?? ""));
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("$schema");
      expect(Object.keys((schema.properties as Record<string, unknown>) ?? {})).toEqual(Object.keys(shape));
    }
  });

  it("never strips a description that explains a parameter the prose does not cover", () => {
    for (const registered of REGISTERED_CTX_TOOLS) {
      const shape = registeredShape(registered.name);
      const schema = zodShapeToJsonSchema(zod3ShapeToV4(shape), String(registered.config.description ?? ""));
      const kept = collectDescriptions(schema as SchemaNode);
      const prose = String(registered.config.description ?? "");
      for (const description of kept) {
        expect(isDescriptionCoveredByProse(description, prose)).toBe(false);
      }
    }
  });
});
