import { describe, it, expect } from "vitest";
import { HookRegistry, registerBuiltinHooks, type HookContext } from "../src/orchestration/hooks.js";

describe("Hook Lifecycle", () => {
  it("fires hooks in priority order", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.register("session.start", "hook-b", async (ctx) => {
      order.push("b");
      return ctx;
    }, 200);

    registry.register("session.start", "hook-a", async (ctx) => {
      order.push("a");
      return ctx;
    }, 100);

    await registry.fire("session.start", {
      sessionId: "s1",
      task: "test",
      event: "session.start",
      data: {}
    });

    expect(order).toEqual(["a", "b"]);
  });

  it("passes modified context through hook chain", async () => {
    const registry = new HookRegistry();

    registry.register("before.plan", "augment", async (ctx) => {
      ctx.data.augmented = true;
      return ctx;
    });

    const result = await registry.fire("before.plan", {
      sessionId: "s1",
      task: "test",
      event: "before.plan",
      data: {}
    });

    expect(result.data.augmented).toBe(true);
  });

  it("catches hook errors without breaking pipeline", async () => {
    const registry = new HookRegistry();

    registry.register("before.execute", "broken", async () => {
      throw new Error("Hook crashed");
    });

    registry.register("before.execute", "healthy", async (ctx) => {
      ctx.data.healthy = true;
      return ctx;
    });

    const result = await registry.fire("before.execute", {
      sessionId: "s1",
      task: "test",
      event: "before.execute",
      data: {}
    });

    expect(result.data.healthy).toBe(true);
    expect((result.data._hookErrors as string[]).length).toBe(1);
  });

  it("unregisters hooks by name", async () => {
    const registry = new HookRegistry();
    registry.register("session.end", "removable", async (ctx) => {
      ctx.data.ran = true;
      return ctx;
    });
    registry.unregister("removable");
    const result = await registry.fire("session.end", {
      sessionId: "s1",
      task: "test",
      event: "session.end",
      data: {}
    });
    expect(result.data.ran).toBeUndefined();
  });

  it("registers builtin hooks without error", () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry);
    const hooks = registry.listHooks();
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.some((h) => h.name === "builtin:cost-tracker")).toBe(true);
    expect(hooks.some((h) => h.name === "builtin:truncate-observation")).toBe(true);
  });

  it("truncation hook truncates large observations", async () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry);

    const bigOutput = "x".repeat(20_000);
    const result = await registry.fire("tool.after", {
      sessionId: "s1",
      task: "test",
      event: "tool.after",
      data: { output: bigOutput }
    });

    expect((result.data.output as string).length).toBeLessThan(bigOutput.length);
    expect(result.data._truncated).toBe(true);
  });
});
