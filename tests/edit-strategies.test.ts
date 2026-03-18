import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { applyEdit, applyEditWithFallback, parseSearchReplaceBlocks } from "../src/tools/edit-strategies.js";

describe("Edit Strategies", () => {
  const tmpDir = path.join(os.tmpdir(), `agent40-edit-test-${Date.now()}`);

  it("applies search-replace edit", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "test.ts"), "const x = 1;\nconst y = 2;\n");

    const result = await applyEdit(tmpDir, {
      strategy: "search-replace",
      filePath: "test.ts",
      content: "<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 42;\n>>>>>>> REPLACE"
    });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, "test.ts"), "utf8");
    expect(content).toContain("const x = 42;");
    expect(content).toContain("const y = 2;");
  });

  it("applies whole-file edit", async () => {
    const result = await applyEdit(tmpDir, {
      strategy: "whole-file",
      filePath: "new-file.ts",
      content: "export const hello = 'world';\n"
    });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, "new-file.ts"), "utf8");
    expect(content).toBe("export const hello = 'world';\n");
  });

  it("fails search-replace when text not found", async () => {
    const result = await applyEdit(tmpDir, {
      strategy: "search-replace",
      filePath: "test.ts",
      content: "<<<<<<< SEARCH\nnonexistent text\n=======\nreplacement\n>>>>>>> REPLACE"
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("falls back to whole-file when search-replace fails", async () => {
    const result = await applyEditWithFallback(tmpDir, {
      strategy: "search-replace",
      filePath: "fallback-test.ts",
      content: "export const fallback = true;\n"
    });

    // search-replace fails (no blocks), falls back to whole-file
    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.strategy).toBe("whole-file");
  });

  it("blocks path escape", async () => {
    const result = await applyEdit(tmpDir, {
      strategy: "whole-file",
      filePath: "../../etc/passwd",
      content: "hacked"
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes");
  });

  describe("parseSearchReplaceBlocks", () => {
    it("parses single block", () => {
      const blocks = parseSearchReplaceBlocks(
        "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe("old");
      expect(blocks[0].replace).toBe("new");
    });

    it("parses multiple blocks", () => {
      const blocks = parseSearchReplaceBlocks(
        "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nsome text\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE"
      );
      expect(blocks).toHaveLength(2);
    });

    it("returns empty for no blocks", () => {
      expect(parseSearchReplaceBlocks("no blocks here")).toHaveLength(0);
    });
  });

  it("cleanup", async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
