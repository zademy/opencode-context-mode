/**
 * OpenCode 2.x plugin surface for open-context-mode.
 *
 * The v1 contract is covered by tests/opencode-plugin.test.ts. This file
 * asserts the v2 registration surface only: that the default export is
 * accepted by the v2 loader schema ({ id, setup }), that every hook is
 * registered on the domain that owns it, and that the v2 event shapes are
 * translated into what the shared handlers expect.
 *
 * The v2 context is hand-rolled rather than imported from @opencode/plugin so
 * the test asserts against the CONTRACT, not against a type that could drift
 * with the installed package version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Hook = (event: any) => unknown;

function makeCtx() {
  const hooks: Record<string, Hook> = {};
  const transforms: Array<(editor: any) => void> = [];
  const events: any[] = [];
  let cleanup: (() => unknown) | undefined;

  const ctx: any = {
    location: { directory: mkdtempSync(join(tmpdir(), "cm-v2-")) },
    tool: {
      hook: async (name: string, cb: Hook) => {
        hooks[`tool.${name}`] = cb;
        return { dispose: async () => {} };
      },
      transform: async (cb: (editor: any) => void) => {
        transforms.push(cb);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name: string, cb: Hook) => {
        hooks[`session.${name}`] = cb;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      }),
    },
  };

  return {
    ctx,
    hooks,
    transforms,
    events,
    get cleanup() {
      return cleanup;
    },
    setCleanup(fn: () => unknown) {
      cleanup = fn;
    },
  };
}

describe("opencode v2 plugin surface", () => {
  let mod: any;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../../src/platforms/opencode/plugin.js");
  });

  describe("default export shape (v2 loader schema)", () => {
    it("exports a default definition with an id and a setup function", () => {
      // The v2 loader rejects anything without BOTH. This mirrors the check
      // that produced `SchemaError(Missing key at ["default"])` on v1 plugins.
      expect(mod.default).toBeTypeOf("object");
      expect(mod.default.id).toBe("opencode-context-mode");
      expect(mod.default.setup).toBeTypeOf("function");
    });

    it("keeps the v1 server entrypoint so v1/KiloCode hosts still load", () => {
      expect(mod.default.server).toBeTypeOf("function");
      expect(mod.ContextModePlugin).toBe(mod.default.server);
    });

    it("does not leak a v1-only hook map from setup", async () => {
      // setup() returns a cleanup, never a v1 hooks object.
      const h = makeCtx();
      const result = await mod.default.setup(h.ctx);
      expect(result === undefined || typeof result === "function").toBe(true);
    });
  });

  describe("hook registration", () => {
    it("registers every v1 hook on its v2 domain, plus session.title and session.retry", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      expect(Object.keys(h.hooks).sort()).toEqual(
        [
          "tool.execute.after",
          "tool.execute.before",
          "session.compaction",
          "session.context",
          "session.prompt",
          "session.title",
          "session.retry",
        ].sort(),
      );
    });

    // Opt-in via env: the trigger matches serialized error text because
    // @opencode/schema is not an installed dependency, so it ships dark.
    describe("session.retry overflow suppression", () => {
      const saved = { ...process.env };
      afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, saved);
      });

      const overflow = () => ({
        sessionID: "ses_retry",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        error: { message: "prompt is too long: 250000 tokens > 200000 maximum" },
        attempt: 1,
        decision: { retry: true, delay: 1000 },
      });

      it("suppresses a context-length retry when opted in", async () => {
        process.env.OPEN_CONTEXT_MODE_SUPPRESS_OVERFLOW_RETRY = "1";
        const h = makeCtx();
        await mod.default.setup(h.ctx);
        const event = overflow();

        await h.hooks["session.retry"](event);

        expect(event.decision).toEqual({ retry: false });
      });

      it("leaves transient failures on the host retry policy", async () => {
        process.env.OPEN_CONTEXT_MODE_SUPPRESS_OVERFLOW_RETRY = "1";
        const h = makeCtx();
        await mod.default.setup(h.ctx);
        const event = { ...overflow(), error: { message: "429 rate limit exceeded" } };

        await h.hooks["session.retry"](event);

        expect(event.decision).toEqual({ retry: true, delay: 1000 });
      });

      it("is off by default", async () => {
        delete process.env.OPEN_CONTEXT_MODE_SUPPRESS_OVERFLOW_RETRY;
        const h = makeCtx();
        await mod.default.setup(h.ctx);
        const event = overflow();

        await h.hooks["session.retry"](event);

        expect(event.decision).toEqual({ retry: true, delay: 1000 });
      });
    });

    it("registers the open_ctx_* tools through a tool transform", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      expect(h.transforms).toHaveLength(1);
      const added: any[] = [];
      h.transforms[0]({ add: (t: any) => added.push(t) });

      expect(added.length).toBeGreaterThan(0);
      for (const tool of added) {
        expect(tool.name).toMatch(/^open_ctx_/);
        expect(tool.description).toBeTypeOf("string");
        // v2 types tool input as JSON Schema, not a Zod object.
        expect(tool.input).toBeTypeOf("object");
        expect(tool.input.type).toBe("object");
        expect(tool.execute).toBeTypeOf("function");
      }
    });

    it("returns a cleanup that aborts the event subscription", async () => {
      const h = makeCtx();
      const cleanup = await mod.default.setup(h.ctx);
      expect(cleanup).toBeTypeOf("function");
      // Must not throw — AbortController.abort() is idempotent.
      cleanup?.();
    });
  });

  describe("v2 event translation", () => {
    it("reads the prompt from event.prompt, not output.parts", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      await h.hooks["session.prompt"]({
        sessionID: "ses_v2_prompt",
        messageID: "msg_1",
        prompt: { text: "remember this decision", files: [] },
      });
      // No throw = the handler accepted the v2 shape.
    });

    it("accepts a SystemPart[] system prompt on the context hook", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const event = {
        sessionID: "ses_v2_ctx",
        system: [{ type: "text", text: "HEADER" }],
        messages: [],
        options: {},
        tools: {},
      };
      await h.hooks["session.context"](event);
      // The routing block lands as a text part, not a bare string.
      const injected = event.system.filter((p: any) => typeof p?.text === "string" && p.text.includes("context_window_protection"));
      expect(injected.length).toBeGreaterThan(0);
      expect(injected[0].type).toBe("text");
      // Header must stay at the FRONT of the prompt so the provider
      // prefix-cache fold survives. #1085: on SystemPart[] hosts the block
      // is consolidated INTO the first part — OpenCode maps every array
      // entry to its own role:"system" message, and a second one fails
      // strict single-system templates (Qwen) with HTTP 500.
      expect(event.system[0].text.startsWith("HEADER")).toBe(true);
      expect(event.system.length).toBe(1);
    });

    it("does not re-inject the routing block on a second context call in the same session", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const make = () => ({
        sessionID: "ses_v2_once",
        system: [{ type: "text", text: "HEADER" }],
        messages: [],
        options: {},
        tools: {},
      });
      const first = make();
      await h.hooks["session.context"](first);
      const second = make();
      await h.hooks["session.context"](second);

      const count = (e: any) => e.system.filter((p: any) => p?.text?.includes?.("context_window_protection")).length;
      expect(count(first)).toBeGreaterThan(0);
      expect(count(second)).toBe(0);
    });

    it("reads the tool result off the event, not a second output argument", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      await h.hooks["tool.execute.after"]({
        tool: "shell",
        sessionID: "ses_v2_after",
        id: "call_1",
        input: { command: "ls" },
        status: "completed",
        result: { content: "ok" },
      });
      await h.hooks["tool.execute.after"]({
        tool: "shell",
        sessionID: "ses_v2_after",
        id: "call_2",
        input: { command: "false" },
        status: "error",
        error: { message: "boom" },
      });
      // Both shapes accepted without throwing.
    });
  });

  describe("v2 event vocabulary", () => {
    it("listens for session.usage.updated, which replaced message.updated", async () => {
      // v1 filtered on the bus event `message.updated`; v2 removed it entirely.
      // Assert the port targets the v2 name so a future rename is caught here.
      const src = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../../src/platforms/opencode/plugin.ts", import.meta.url), "utf-8"),
      );
      expect(src).toContain("session.usage.updated");
      expect(src).toContain("session.model.selected");
    });
  });

  // Issue #1036. Measured against a live opencode 2.0.22 server: a three-step
  // turn emitted session.usage.updated with tokens.input climbing
  // 1279918 → 1280031 → 1280078. The payload is the session running total and
  // the event fires once per step, so inserting it verbatim records the
  // cumulative total three times.
  describe("usage delta accounting (issue #1036)", () => {
    const snap = (input: number, output: number, cost = 0) => ({
      input,
      output,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
    });

    it("reports the whole total for the first snapshot seen in a session", () => {
      const d = mod.usageDelta(undefined, snap(1279918, 51672));
      expect(d).not.toBeNull();
      expect(d!.tokens.input).toBe(1279918);
      expect(d!.tokens.output).toBe(51672);
    });

    it("reports only the step between two cumulative snapshots", () => {
      const d = mod.usageDelta(snap(1279918, 51672), snap(1280031, 51746));
      expect(d!.tokens.input).toBe(113);
      expect(d!.tokens.output).toBe(74);
    });

    it("sums a three-step turn to the session total, not 3x it", () => {
      const steps = [snap(1279918, 51672), snap(1280031, 51746), snap(1280078, 51865)];
      let prev: any;
      let inSum = 0;
      let outSum = 0;
      let events = 0;
      for (const s of steps) {
        const d = mod.usageDelta(prev, s);
        prev = s;
        if (!d) continue;
        events++;
        inSum += d.tokens.input as number;
        outSum += d.tokens.output as number;
      }
      expect(events).toBe(3);
      // The deltas must reconstruct the final cumulative value exactly.
      expect(inSum).toBe(steps[2].input);
      expect(outSum).toBe(steps[2].output);
      // The bug being guarded: inserting each payload verbatim triples it.
      const verbatim = steps.reduce((a, s) => a + s.input, 0);
      expect(verbatim).toBe(3840027);
      expect(verbatim / inSum).toBeCloseTo(3, 1);
    });

    it("deltas cost as well as tokens", () => {
      const d = mod.usageDelta(snap(100, 10, 0.5), snap(150, 20, 0.9));
      expect(d!.cost).toBeCloseTo(0.4, 6);
    });

    it("returns null for a repeated snapshot so nothing is inserted", () => {
      const s = snap(100, 10, 0.25);
      expect(mod.usageDelta(s, { ...s })).toBeNull();
    });

    it("clamps a counter reset to zero, which records nothing", () => {
      // A reset (new session reusing counters, or a server recompute) makes
      // every delta negative. Clamping to zero leaves nothing moved, and
      // "nothing moved" is the signal to skip the insert — so no bogus or
      // negative usage event reaches the DB.
      expect(mod.usageDelta(snap(500, 100, 2), snap(10, 5, 0))).toBeNull();
    });

    it("still records the part of a reset snapshot that did not go backwards", () => {
      // Mixed case: input went backwards but output and cache moved forward.
      // The forward half must survive; only the backwards half is clamped.
      const d = mod.usageDelta(snap(500, 100, 2), snap(10, 130, 3));
      expect(d).not.toBeNull();
      expect(d!.tokens.input).toBe(0);
      expect(d!.tokens.output).toBe(30);
      expect(d!.cost).toBe(1);
    });

    it("reads a v2 payload, treating missing fields as zero", () => {
      expect(
        mod.readUsageSnapshot({
          tokens: { input: 7, output: 3, cache: { read: 2, write: 1 } },
          cost: 1.5,
        }),
      ).toEqual({
        input: 7,
        output: 3,
        reasoning: 0,
        cacheRead: 2,
        cacheWrite: 1,
        cost: 1.5,
      });
      expect(mod.readUsageSnapshot({ tokens: {} })).toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      });
      expect(mod.readUsageSnapshot({})).toBeNull();
    });
  });

  // `SessionTitle.result` is the SDK's own short-circuit: set it and the
  // title model request never fires. OpenCode would otherwise spend a whole
  // request (system + transcript + the open_ctx_* tool surface) naming a session.
  describe("session.title short-circuit", () => {
    const titleEvent = (messages: any[]) => ({
      sessionID: "ses_title",
      model: { providerID: "test", modelID: "test" },
      system: [],
      messages,
      options: {},
    });

    it("derives a title from the first user message and skips the model request", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const event = titleEvent([
        { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        { role: "user", content: [{ type: "text", text: "Fix the routing leak in PreToolUse" }] },
      ]);

      await h.hooks["session.title"](event);

      expect(event.result).toBe("Fix the routing leak in PreToolUse");
    });

    it("uses the first line of a multi-line prompt", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const event = titleEvent([{ role: "user", content: [{ type: "text", text: "\n\n## Audit the plugin\nlots of detail" }] }]);

      await h.hooks["session.title"](event);

      expect(event.result).toBe("Audit the plugin");
    });

    it("truncates an over-long first line", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const event = titleEvent([{ role: "user", content: [{ type: "text", text: "x".repeat(200) }] }]);

      await h.hooks["session.title"](event);

      expect(event.result).toBe(`${"x".repeat(69)}...`);
    });

    // Fail-safe contract: an empty prompt must leave `result` unset so the
    // host runs its own request. The hook may save work, never break naming.
    it("leaves result unset when no user text exists", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      const event = titleEvent([{ role: "user", content: [{ type: "image", url: "x" }] }]);

      await h.hooks["session.title"](event);

      expect(event.result).toBeUndefined();
    });
  });

  // v2's `context` hook is the only place a plugin is handed the outbound
  // messages as a live mutable value. v1's messages.transform delivered `{}`
  // and was silently dropped (PR #376), which is why this is v2-only.
  describe("transcript elision on the context hook", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    });

    /** An oversized native bash result plus a trailing turn to keep it off the tail. */
    const floodEvent = (sessionID: string, text: string) => ({
      sessionID,
      system: [{ type: "text", text: "HEADER" }],
      messages: [
        {
          role: "tool",
          content: [{ type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: text } }],
        },
        { role: "user", content: [{ type: "text", text: "next?" }] },
      ],
      options: {},
      tools: {},
    });
    const resultText = (e: any) => e.messages[0].content[0].result.value;

    it("caps an oversized native result and points at the indexed source", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "500";
      process.env.OPEN_CONTEXT_MODE_ELIDE_CAP_BYTES = "200";
      process.env.OPEN_CONTEXT_MODE_ELIDE_KEEP_RECENT = "1";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      const event = floodEvent("ses_elide_1", "BUILDLOG".repeat(500));
      const before = resultText(event).length;
      await h.hooks["session.context"](event);

      expect(resultText(event).length).toBeLessThan(before);
      expect(resultText(event)).toContain('source "cm-elide/bash/call_1"');
      expect(resultText(event)).toContain("open_ctx_search");
    });

    it("leaves a small native result alone", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "500";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      const event = floodEvent("ses_elide_small", "tiny");
      await h.hooks["session.context"](event);
      expect(resultText(event)).toBe("tiny");
    });

    it("leaves the transcript intact when elision is switched off", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE = "0";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      const text = "BUILDLOG".repeat(500);
      const event = floodEvent("ses_elide_off", text);
      await h.hooks["session.context"](event);
      expect(resultText(event)).toBe(text);
    });

    // open_ctx_* results already pass the output ladder, which shrank them on
    // purpose. Rewriting them here would undo work the pipeline just did.
    it("never elides a open_ctx_* result", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "500";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      const text = "SUMMARY".repeat(500);
      const event = floodEvent("ses_elide_ctx", text);
      event.messages[0].content[0].name = "open_ctx_execute";
      await h.hooks["session.context"](event);
      expect(resultText(event)).toBe(text);
    });

    // At compaction time the model is summarizing the conversation and needs
    // the full history. `compaction` must not run the pass.
    it("does not elide during compaction", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "500";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      const text = "HISTORY".repeat(500);
      const event: any = {
        sessionID: "ses_elide_compact",
        system: [{ type: "text", text: "HEADER" }],
        messages: [
          { role: "tool", content: [{ type: "tool-result", id: "call_c", name: "bash", result: { type: "text", value: text } }] },
          { role: "user", content: [{ type: "text", text: "next?" }] },
        ],
        options: {},
        tools: {},
      };
      await h.hooks["session.compaction"](event);
      expect(event.messages[0].content[0].result.value).toBe(text);
    });

    // The whole design rests on this: a pointer is only ever written for bytes
    // that are already retrievable. If the elided text cannot be found again
    // by the query the marker hands the model, the pass is data loss wearing a
    // safety label.
    it("indexes the elided bytes so open_ctx_search can actually retrieve them", async () => {
      process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "500";
      process.env.OPEN_CONTEXT_MODE_ELIDE_CAP_BYTES = "200";
      process.env.OPEN_CONTEXT_MODE_ELIDE_KEEP_RECENT = "1";
      const h = makeCtx();
      await mod.default.setup(h.ctx);

      // The unique token goes in the MIDDLE: head and tail are kept by design,
      // so a token at either end would survive the elision and prove nothing.
      const unique = "zzmarkerquuxbaz";
      const event = floodEvent("ses_elide_search", `HEADLOG${"fillerlog".repeat(400)}${unique}${"traillog".repeat(400)}`);
      await h.hooks["session.context"](event);
      expect(resultText(event)).not.toContain(unique); // gone from the transcript

      // Recover through the PUBLIC interface: the open_ctx_search call the injected
      // marker literally instructs the model to make. Proving retrievability
      // via the same tool the model would reach for is the whole claim.
      const tools: Record<string, any> = {};
      for (const transform of h.transforms) transform({ add: (t: any) => (tools[t.name] = t) });
      const found = await tools.open_ctx_search.execute(
        { queries: ["zzmarkerquuxbaz"], source: "cm-elide/bash/call_1" },
        { sessionID: "ses_elide_search" },
      );
      expect(found.content).toContain(unique);
    });

    it("survives a messages array that is absent", async () => {
      const h = makeCtx();
      await mod.default.setup(h.ctx);
      await expect(h.hooks["session.context"]({ sessionID: "ses_elide_none", system: [], options: {}, tools: {} })).resolves.not.toThrow();
    });
  });

  it("#1085: consolidates injections into ONE system part for strict single-system templates", async () => {
    const h = makeCtx();
    await mod.default.setup(h.ctx);
    const event = {
      sessionID: "ses_v2_1085",
      system: [{ type: "text", text: "HEADER" }],
      messages: [],
      options: {},
      tools: {},
    };
    await h.hooks["session.context"](event);
    // Exactly one system entry survives: OpenCode maps each array entry to
    // its own role:"system" message, and local Qwen templates reject a
    // second one with HTTP 500.
    expect(event.system.length).toBe(1);
    expect(event.system[0].text.startsWith("HEADER")).toBe(true);
    expect(event.system[0].text).toContain("context_window_protection");
  });
});
