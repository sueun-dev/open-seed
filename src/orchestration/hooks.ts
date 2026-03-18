/**
 * Hook Lifecycle System (inspired by everything-claude-code).
 *
 * Hooks fire at key lifecycle points:
 * - session.start: initialize per-session context
 * - before.plan: augment task before planning
 * - after.plan: inspect/modify plan before execution
 * - before.execute: augment execution context
 * - after.execute: inspect results, trigger follow-ups
 * - before.review: augment review context
 * - after.review: react to review verdict
 * - session.end: cleanup, save state, learn
 *
 * Hooks are functions registered by plugins, skills, or config.
 */

export type HookEvent =
  | "session.start"
  | "before.plan"
  | "after.plan"
  | "before.execute"
  | "after.execute"
  | "before.review"
  | "after.review"
  | "session.end"
  | "tool.before"
  | "tool.after"
  | "checkpoint.saved";

export interface HookContext {
  sessionId: string;
  task: string;
  event: HookEvent;
  data: Record<string, unknown>;
}

export type HookHandler = (context: HookContext) => Promise<HookContext> | HookContext;

interface RegisteredHook {
  event: HookEvent;
  name: string;
  priority: number;
  handler: HookHandler;
}

export class HookRegistry {
  private hooks: RegisteredHook[] = [];

  register(event: HookEvent, name: string, handler: HookHandler, priority = 100): void {
    this.hooks.push({ event, name, priority, handler });
    // Keep sorted by priority (lower = earlier)
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  async fire(event: HookEvent, context: HookContext): Promise<HookContext> {
    let ctx = { ...context, event };
    const handlers = this.hooks.filter((h) => h.event === event);

    for (const hook of handlers) {
      try {
        ctx = await hook.handler(ctx);
      } catch (error) {
        // Hook errors don't break the pipeline, but we record them
        ctx.data._hookErrors = ctx.data._hookErrors ?? [];
        (ctx.data._hookErrors as string[]).push(
          `${hook.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return ctx;
  }

  listHooks(): Array<{ event: HookEvent; name: string; priority: number }> {
    return this.hooks.map((h) => ({ event: h.event, name: h.name, priority: h.priority }));
  }
}

/**
 * Built-in hooks that ship with agent40.
 */
export function registerBuiltinHooks(registry: HookRegistry): void {
  // Cost tracking hook
  registry.register("after.execute", "builtin:cost-tracker", async (ctx) => {
    const usage = ctx.data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (usage) {
      const costs = (ctx.data._costs ?? { totalInput: 0, totalOutput: 0 }) as {
        totalInput: number;
        totalOutput: number;
      };
      costs.totalInput += usage.inputTokens ?? 0;
      costs.totalOutput += usage.outputTokens ?? 0;
      ctx.data._costs = costs;
    }
    return ctx;
  }, 10);

  // Observation truncation hook (SWE-agent pattern)
  registry.register("tool.after", "builtin:truncate-observation", async (ctx) => {
    const output = ctx.data.output;
    if (typeof output === "string" && output.length > 10_000) {
      ctx.data.output = output.slice(0, 4_000) + "\n...[truncated]...\n" + output.slice(-4_000);
      ctx.data._truncated = true;
    }
    return ctx;
  }, 20);

  // Session timing hook
  registry.register("session.start", "builtin:timer", async (ctx) => {
    ctx.data._startTime = Date.now();
    return ctx;
  }, 1);

  registry.register("session.end", "builtin:timer", async (ctx) => {
    const start = ctx.data._startTime as number | undefined;
    if (start) {
      ctx.data._durationMs = Date.now() - start;
    }
    return ctx;
  }, 1);
}
