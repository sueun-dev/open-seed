import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { checkComments } from "../src/tools/comment-checker.js";

async function createTempProject(files: Record<string, string>): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `agent40-comment-check-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return tmpDir;
}

describe("comment-checker", () => {
  it("detects TODO comments", async () => {
    const dir = await createTempProject({
      "src/index.ts": `
export function main() {
  // TODO: implement this properly
  return null;
}
`
    });
    try {
      const result = await checkComments({ cwd: dir });
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("todo");
      expect(result.findings[0].line).toBe(3);
      expect(result.summary.todos).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects FIXME as error severity", async () => {
    const dir = await createTempProject({
      "app.ts": `
const x = 1; // FIXME: this is wrong
`
    });
    try {
      const result = await checkComments({ cwd: dir });
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("fixme");
      expect(result.findings[0].severity).toBe("error");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects HACK/XXX as error severity", async () => {
    const dir = await createTempProject({
      "util.ts": `
// HACK: workaround for broken API
// XXX: this needs refactoring
`
    });
    try {
      const result = await checkComments({ cwd: dir });
      expect(result.findings.length).toBe(2);
      expect(result.findings.every((f) => f.severity === "error")).toBe(true);
      expect(result.summary.hacks).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects commented-out code", async () => {
    const dir = await createTempProject({
      "old.ts": `
// import fs from 'fs';
// const x = 42;
// function removed() {}
export function current() {}
`
    });
    try {
      const result = await checkComments({ cwd: dir });
      const codeFindings = result.findings.filter((f) => f.kind === "commented-code");
      expect(codeFindings.length).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects empty comments", async () => {
    const dir = await createTempProject({
      "sparse.ts": `
//
export const a = 1;
//
export const b = 2;
`
    });
    try {
      const result = await checkComments({ cwd: dir, includeWarnings: true });
      expect(result.summary.emptyComments).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("filters warnings when includeWarnings is false", async () => {
    const dir = await createTempProject({
      "mixed.ts": `
// TODO: add this later (warning)
// FIXME: broken (error)
// const oldCode = true; (warning - commented code)
`
    });
    try {
      const result = await checkComments({ cwd: dir, includeWarnings: false });
      // Only FIXME (error) should remain
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("fixme");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips non-code files", async () => {
    const dir = await createTempProject({
      "README.md": "# TODO: write docs",
      "data.json": '{ "todo": true }',
      "src/real.ts": "// TODO: fix this"
    });
    try {
      const result = await checkComments({ cwd: dir });
      // Only the .ts file should be scanned
      expect(result.files).toBe(1);
      expect(result.findings.length).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips node_modules and dist", async () => {
    const dir = await createTempProject({
      "node_modules/pkg/index.js": "// TODO: not scanned",
      "dist/bundle.js": "// FIXME: not scanned",
      "src/app.ts": "// clean code here\nexport const x = 1;"
    });
    try {
      const result = await checkComments({ cwd: dir });
      expect(result.files).toBe(1);
      expect(result.findings.length).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("works with specific file paths", async () => {
    const dir = await createTempProject({
      "a.ts": "// TODO: task A",
      "b.ts": "// TODO: task B"
    });
    try {
      const result = await checkComments({ cwd: dir, paths: ["a.ts"] });
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].text).toContain("task A");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns clean result for well-written code", async () => {
    const dir = await createTempProject({
      "clean.ts": `
/** Calculate the sum of two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}
`
    });
    try {
      const result = await checkComments({ cwd: dir });
      expect(result.findings.length).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
