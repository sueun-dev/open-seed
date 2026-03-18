import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ProjectMemoryStore } from "../src/memory/project-memory.js";

describe("Project Memory", () => {
  const tmpDir = path.join(os.tmpdir(), `agent40-mem-test-${Date.now()}`);

  it("creates empty memory on first load", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    const mem = await store.load();
    expect(mem.version).toBe(1);
    expect(mem.hotPaths).toEqual({});
  });

  it("records file access and tracks hot paths", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    await store.recordFileAccess("src/index.ts");
    await store.recordFileAccess("src/index.ts");
    await store.recordFileAccess("src/cli.ts");
    const hot = await store.getHotPaths();
    expect(hot[0].path).toBe("src/index.ts");
    expect(hot[0].count).toBe(2);
  });

  it("records tool call stats", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    await store.recordToolCall("read", true);
    await store.recordToolCall("read", true);
    await store.recordToolCall("read", false);
    await store.recordToolCall("bash", true);
    const mem = await store.load();
    expect(mem.toolStats["read"].calls).toBe(3);
    expect(mem.toolStats["read"].successes).toBe(2);
    expect(mem.toolStats["read"].failures).toBe(1);
    expect(mem.toolStats["bash"].calls).toBe(1);
  });

  it("learns build/test commands from bash output", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    await store.learnFromBashOutput("npm run build", "compiled successfully");
    await store.learnFromBashOutput("npm test", "24 tests passed");
    const mem = await store.load();
    expect(mem.buildCommands).toContain("npm run build");
    expect(mem.testCommands).toContain("npm test");
  });

  it("captures error patterns", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    await store.learnFromBashOutput("npm run build", "Error: Cannot find module './missing'\nsome other output");
    const mem = await store.load();
    expect(mem.errorPatterns.length).toBe(1);
    expect(mem.errorPatterns[0]).toContain("Cannot find module");
  });

  it("generates context string", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    const ctx = await store.getContext();
    expect(ctx).toContain("Build commands:");
    expect(ctx).toContain("Hot files:");
  });

  it("adds custom notes", async () => {
    const store = new ProjectMemoryStore(tmpDir);
    await store.addNote("Always run tests before commit");
    const mem = await store.load();
    expect(mem.customNotes).toContain("Always run tests before commit");
  });

  it("persists across instances", async () => {
    const store2 = new ProjectMemoryStore(tmpDir);
    const mem = await store2.load();
    expect(mem.buildCommands).toContain("npm run build");
    expect(mem.hotPaths["src/index.ts"]).toBe(2);
  });

  it("cleanup", async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
