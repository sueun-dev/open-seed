import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyHashEdits, readFileWithHashes, StaleHashEditError } from "../src/tools/hashline.js";

const tempDirs: string[] = [];

async function makeTempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-hashline-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "sample.txt");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("hashline", () => {
  it("replaces matching lines by hash", async () => {
    const filePath = await makeTempFile("a\nb\nc");
    const lines = await readFileWithHashes(filePath);
    await applyHashEdits(filePath, [{ type: "replace", hash: lines[1].hash, newText: "beta" }]);
    expect(await fs.readFile(filePath, "utf8")).toBe("a\nbeta\nc");
  });

  it("rejects stale edits", async () => {
    const filePath = await makeTempFile("x\ny");
    await expect(applyHashEdits(filePath, [{ type: "delete", hash: "deadbeef" }])).rejects.toBeInstanceOf(StaleHashEditError);
  });
});
