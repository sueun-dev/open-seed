import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLatestBrowserCheckpoint, writeBrowserCheckpoint, listLatestBrowserCheckpoints } from "../src/tools/browser-session.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-browser-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("browser-session", () => {
  it("persists and reloads latest checkpoints per session name", async () => {
    const cwd = await makeProject();

    await writeBrowserCheckpoint({
      cwd,
      localDirName: ".agent",
      sessionId: "ses_1",
      sessionName: "default",
      action: "open",
      url: "https://example.com",
      title: "Example Domain"
    });

    const latest = await readLatestBrowserCheckpoint(cwd, ".agent", "ses_1", "default");
    expect(latest?.url).toBe("https://example.com");
    expect(latest?.title).toBe("Example Domain");
  });

  it("lists latest checkpoints for the requested session only", async () => {
    const cwd = await makeProject();

    await writeBrowserCheckpoint({
      cwd,
      localDirName: ".agent",
      sessionId: "ses_1",
      sessionName: "default",
      action: "open",
      url: "https://example.com",
      title: "Example"
    });
    await writeBrowserCheckpoint({
      cwd,
      localDirName: ".agent",
      sessionId: "ses_1",
      sessionName: "checkout flow",
      action: "click",
      url: "https://example.com/cart",
      title: "Cart"
    });
    await writeBrowserCheckpoint({
      cwd,
      localDirName: ".agent",
      sessionId: "ses_2",
      sessionName: "default",
      action: "open",
      url: "https://ignored.example",
      title: "Ignored"
    });

    const checkpoints = await listLatestBrowserCheckpoints(cwd, ".agent", "ses_1");
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map((checkpoint) => checkpoint.sessionId)).toEqual(["ses_1", "ses_1"]);
    expect(checkpoints.map((checkpoint) => checkpoint.sessionName).sort()).toEqual(["checkout flow", "default"]);
  });
});
