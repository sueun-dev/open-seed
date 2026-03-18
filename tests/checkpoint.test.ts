import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { FileCheckpointSaver, createCheckpoint } from "../src/orchestration/checkpoint.js";

describe("Checkpoint System", () => {
  const tmpDir = path.join(os.tmpdir(), `agent40-chk-test-${Date.now()}`);

  it("saves and loads a checkpoint", async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    const chk = createCheckpoint("ses1", "planner", 1, { plan: "test plan" });
    await saver.save(chk);
    const loaded = await saver.load("ses1", chk.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.node).toBe("planner");
    expect(loaded!.state.plan).toBe("test plan");
  });

  it("returns latest checkpoint", async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    const chk1 = createCheckpoint("ses2", "planner", 1, { step: 1 });
    const chk2 = createCheckpoint("ses2", "executor", 2, { step: 2 });
    await saver.save(chk1);
    await saver.save(chk2);
    const latest = await saver.latest("ses2");
    expect(latest).not.toBeNull();
    expect(latest!.step).toBe(2);
    expect(latest!.node).toBe("executor");
  });

  it("lists all checkpoints in order", async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    const all = await saver.list("ses2");
    expect(all.length).toBe(2);
    expect(all[0].step).toBe(1);
    expect(all[1].step).toBe(2);
  });

  it("forks a checkpoint to a new session", async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    const chk = createCheckpoint("ses3", "planner", 1, { data: "original" });
    await saver.save(chk);
    const forked = await saver.fork("ses3", chk.id, "ses3-fork");
    expect(forked).not.toBeNull();
    expect(forked!.sessionId).toBe("ses3-fork");
    expect(forked!.parentId).toBe(chk.id);
    expect(forked!.state.data).toBe("original");
    expect(forked!.step).toBe(0);
  });

  it("returns null for missing checkpoints", async () => {
    const saver = new FileCheckpointSaver(tmpDir);
    const result = await saver.load("nonexistent", "nonexistent");
    expect(result).toBeNull();
    const latest = await saver.latest("nonexistent");
    expect(latest).toBeNull();
  });

  // Cleanup
  it("cleanup", async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
