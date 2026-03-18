import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We test the command by importing it and running against a temp dir
import { runInitDeepCommand } from "../src/commands/init-deep.js";

describe("init-deep command", () => {
  it("generates AGENTS.md files in a sample project structure", async () => {
    // Create a temp directory with a simple structure
    const tmpDir = path.join(os.tmpdir(), `agent40-init-deep-test-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });

    // Create some source files
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-project" }));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export function main() {}\n");
    await fs.writeFile(path.join(tmpDir, "src", "utils.ts"), "export function helper() {}\n");
    await fs.writeFile(path.join(tmpDir, "tests", "index.test.ts"), "import { describe, it } from 'vitest';\n");
    await fs.writeFile(path.join(tmpDir, "tests", "utils.test.ts"), "import { describe, it } from 'vitest';\n");

    // Run the command in that dir
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runInitDeepCommand();

      // Check that root AGENTS.md was created
      const rootAgents = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
      expect(rootAgents).toContain("Project Root");
      expect(rootAgents).toContain("Conventions");

      // Check that src/AGENTS.md was created
      const srcAgents = await fs.readFile(path.join(tmpDir, "src", "AGENTS.md"), "utf8");
      expect(srcAgents).toContain("src");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing AGENTS.md files", async () => {
    const tmpDir = path.join(os.tmpdir(), `agent40-init-deep-nooverwrite-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });

    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export {};\n");
    await fs.writeFile(path.join(tmpDir, "src", "foo.ts"), "export {};\n");

    // Create an existing AGENTS.md
    const existingContent = "# Custom instructions\nDo not change this.";
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), existingContent);

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runInitDeepCommand();

      // Root AGENTS.md should not be overwritten
      const rootAgents = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
      expect(rootAgents).toBe(existingContent);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
