import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig, loadConfig, writeDefaultConfig } from "../src/core/config.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-config-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("config loading", () => {
  it("deep-merges nested config values with defaults", async () => {
    const cwd = await makeProject();
    const partial = {
      tools: {
        browser: false
      },
      browser: {
        doctorSmokeTest: true
      },
      safety: {
        autoApprove: ["read"]
      }
    };
    await fs.writeFile(path.join(cwd, ".agent", "config.json"), JSON.stringify(partial, null, 2), "utf8");

    const loaded = await loadConfig(cwd);
    const defaults = createDefaultConfig();

    expect(loaded.tools.browser).toBe(false);
    expect(loaded.tools.parallelReadMax).toBe(defaults.tools.parallelReadMax);
    expect(loaded.tools.lsp).toBe(defaults.tools.lsp);
    expect(loaded.browser.doctorSmokeTest).toBe(true);
    expect(loaded.browser.headless).toBe(defaults.browser.headless);
    expect(loaded.safety.autoApprove).toEqual(["read"]);
    expect(loaded.safety.requireApproval).toEqual(defaults.safety.requireApproval);
  });
});
