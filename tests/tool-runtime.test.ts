import fs from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig, writeDefaultConfig } from "../src/core/config.js";
import { ApprovalEngine } from "../src/safety/approval.js";
import { getRoleRegistry, resolveRole } from "../src/roles/registry.js";
import { SessionApprovalResolver } from "../src/safety/resolver.js";
import { SessionStore } from "../src/sessions/store.js";
import { ToolRuntime } from "../src/tools/runtime.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-tools-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  await fs.writeFile(path.join(cwd, "index.ts"), "export const value = 1;\n", "utf8");
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ToolRuntime", () => {
  it("blocks write calls when approval is required", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test write approval");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const result = await runtime.execute({
      name: "write",
      reason: "Modify the file",
      input: {
        path: "index.ts",
        content: "export const value = 2;\n"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.approval.approved).toBe(false);
    expect(await fs.readFile(path.join(cwd, "index.ts"), "utf8")).toContain("value = 1");
  });

  it("dedupes identical read-only calls inside a plan", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test dedupe");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const results = await runtime.executePlan([
      {
        name: "read",
        reason: "Read index once",
        input: { path: "index.ts" }
      },
      {
        name: "read",
        reason: "Read index twice",
        input: { path: "index.ts" }
      }
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    const events = await store.readEvents(session.id);
    expect(events.filter((event) => event.type === "tool.called" && event.payload.tool === "read")).toHaveLength(1);
  });

  it("parallelizes read-only batches within the configured limit", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    config.team.maxWorkers = 4;
    config.tools.parallelReadMax = 4;
    await Promise.all([
      fs.writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n", "utf8"),
      fs.writeFile(path.join(cwd, "b.ts"), "export const b = 1;\n", "utf8"),
      fs.writeFile(path.join(cwd, "c.ts"), "export const c = 1;\n", "utf8")
    ]);
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test parallel reads");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety),
      latencyOverridesMs: {
        read: 80
      }
    });

    const start = performance.now();
    const results = await runtime.executePlan([
      { name: "read", reason: "read a", input: { path: "index.ts" } },
      { name: "read", reason: "read b", input: { path: "a.ts" } },
      { name: "read", reason: "read c", input: { path: "b.ts" } },
      { name: "read", reason: "read d", input: { path: "c.ts" } }
    ]);
    const elapsed = performance.now() - start;

    expect(results.every((result) => result.ok)).toBe(true);
    expect(elapsed).toBeLessThan(260);
  });

  it("preserves order around side-effect boundaries", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    config.safety.autoApprove = [...config.safety.autoApprove, "write"];
    config.safety.requireApproval = config.safety.requireApproval.filter((action) => action !== "write");
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test side effects");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const results = await runtime.executePlan([
      {
        name: "write",
        reason: "Update the file first",
        input: { path: "index.ts", content: "export const value = 3;\n" }
      },
      {
        name: "read",
        reason: "Read the updated file",
        input: { path: "index.ts" }
      }
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    expect((results[1].output as { content: string }).content).toContain("value = 3");
  });

  it("can approve writes through a resolver even when policy is ask", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test resolver approval");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety),
      approvalResolver: new SessionApprovalResolver({
        env: {
          AGENT40_AUTO_APPROVE: "write"
        },
        interactive: false
      })
    });

    const result = await runtime.execute({
      name: "write",
      reason: "Modify the file with resolver approval",
      input: {
        path: "index.ts",
        content: "export const value = 4;\n"
      }
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(cwd, "index.ts"), "utf8")).toContain("value = 4");
  });

  it("records stream events for bash output", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    config.safety.autoApprove = [...config.safety.autoApprove, "bash_side_effect"];
    config.safety.requireApproval = config.safety.requireApproval.filter((action) => action !== "bash_side_effect");
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test bash stream");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const result = await runtime.execute({
      name: "bash",
      reason: "Emit stdout for streaming",
      input: {
        command: "printf 'hello-stream'"
      }
    });

    expect(result.ok).toBe(true);
    const events = await store.readEvents(session.id);
    const streamEvents = events.filter((event) => event.type === "tool.stream");
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.payload.chunk).toContain("hello-stream");
  });

  it("marks non-zero bash exits as failed tool results", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    config.safety.autoApprove = [...config.safety.autoApprove, "bash_side_effect"];
    config.safety.requireApproval = config.safety.requireApproval.filter((action) => action !== "bash_side_effect");
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test bash failure");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const result = await runtime.execute({
      name: "bash",
      reason: "Return a failing exit code",
      input: {
        command: "exit 2"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exit code 2");
    expect(result.output).toMatchObject({ exitCode: 2 });
  });

  it("treats read-only git probes as unavailable instead of failed outside a git repo", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("test git unavailable");
    const role = resolveRole(getRoleRegistry(config), "executor");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const result = await runtime.execute({
      name: "git",
      reason: "Inspect repo status safely",
      input: {
        args: ["status", "--short"]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      available: false,
      repository: false
    });
  });
});
