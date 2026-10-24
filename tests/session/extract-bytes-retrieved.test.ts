/**
 * Retrieval-cost capture — the OTHER half of the open-context-mode with/without ratio.
 *
 * `bytes_avoided` measures content kept OUT of the model context. `bytes_retrieved`
 * measures the bytes the model PAID to ACCESS that kept-out content — the
 * tool_response size of `open_ctx_search` and `open_ctx_fetch_and_index` MCP calls.
 *
 * Sandbox compute (`open_ctx_execute` / `open_ctx_batch_execute` / `open_ctx_execute_file`) is
 * work-output, NOT retrieval — it must NOT carry bytes_retrieved.
 *
 * Suffix-match note: MCP tool names are host-prefixed
 * (`mcp__plugin_open-context-mode_open-context-mode__open_ctx_search`); we match by suffix,
 * char-algorithmically, never by regex.
 */

import { describe, test, expect } from "vite-plus/test";
import { extractEvents } from "../../src/session/extract.js";

function mcpEventsOf(toolName: string, toolResponse: string) {
  return extractEvents({
    tool_name: toolName,
    tool_input: { queries: ["q"] },
    tool_response: toolResponse,
  }).filter((e) => e.type === "mcp_tool_call");
}

describe("extractMcpToolCall — bytes_retrieved (retrieval cost)", () => {
  test("open_ctx_search PostToolUse carries bytes_retrieved = response byte length", () => {
    const response = "matched section A\nmatched section B — retrieved content";
    const events = mcpEventsOf("mcp__plugin_open-context-mode_open-context-mode__open_ctx_search", response);

    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBe(Buffer.byteLength(response, "utf8"));
  });

  test("open_ctx_fetch_and_index carries bytes_retrieved = response byte length", () => {
    const response = "Fetched and indexed 4 sections (12.5KB)\n…matched windows…";
    const events = mcpEventsOf("mcp__plugin_open-context-mode_open-context-mode__open_ctx_fetch_and_index", response);

    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBe(Buffer.byteLength(response, "utf8"));
  });

  test("multibyte tool_response is measured in BYTES, not chars", () => {
    const response = "café — 文字 — 🎯"; // multibyte: bytes > chars
    const events = mcpEventsOf("mcp__plugin_open-context-mode_open-context-mode__open_ctx_search", response);

    expect(events[0].bytes_retrieved).toBe(Buffer.byteLength(response, "utf8"));
    expect(events[0].bytes_retrieved).toBeGreaterThan(response.length);
  });

  test("open_ctx_execute (sandbox compute) does NOT carry bytes_retrieved", () => {
    const events = mcpEventsOf("mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute", "stdout: 47 files analyzed");

    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("open_ctx_batch_execute (sandbox compute) does NOT carry bytes_retrieved", () => {
    const events = mcpEventsOf(
      "mcp__plugin_open-context-mode_open-context-mode__open_ctx_batch_execute",
      "Executed 4 commands. Indexed 39 sections.",
    );

    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("open_ctx_search with empty tool_response does NOT carry bytes_retrieved", () => {
    const events = mcpEventsOf("mcp__plugin_open-context-mode_open-context-mode__open_ctx_search", "");

    expect(events.length).toBe(1);
    expect(events[0].bytes_retrieved).toBeUndefined();
  });

  test("suffix match: a tool whose name merely CONTAINS open_ctx_search mid-string is still retrieval (ends-with the suffix)", () => {
    // Sanity: a name that ends with the suffix matches regardless of prefix.
    const response = "retrieved payload";
    const events = mcpEventsOf("mcp__other_host__open_ctx_search", response);
    expect(events[0].bytes_retrieved).toBe(Buffer.byteLength(response, "utf8"));
  });
});
