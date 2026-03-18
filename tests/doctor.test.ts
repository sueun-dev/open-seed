import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const browserProbeCalls: Array<{ smokeTest?: boolean; headless?: boolean }> = [];

vi.mock("../src/tools/browser.js", () => {
  return {
    async getBrowserHealth(options?: { smokeTest?: boolean; headless?: boolean }) {
      browserProbeCalls.push(options ?? {});
      return {
        available: true,
        smokeTested: options?.smokeTest === true,
        canLaunch: options?.smokeTest === true ? true : undefined,
        executablePath: "/mock/chromium"
      };
    }
  };
});

import { writeDefaultConfig } from "../src/core/config.js";
import { runDoctorCommand } from "../src/commands/doctor.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-doctor-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS\n\n- Test context\n", "utf8");
  return cwd;
}

afterEach(async () => {
  browserProbeCalls.length = 0;
  process.env = { ...originalEnv };
  process.chdir(originalCwd);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("doctor command", () => {
  it("runs browser smoke checks when enabled in config", async () => {
    const cwd = await makeProject();
    const configPath = path.join(cwd, ".agent", "config.json");
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw) as { browser: { doctorSmokeTest?: boolean } };
    config.browser.doctorSmokeTest = true;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    process.chdir(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDoctorCommand();

    expect(browserProbeCalls[0]).toMatchObject({
      smokeTest: true,
      headless: true
    });
    const rendered = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(rendered).toContain("browser");
    expect(rendered).toContain("smoke=ok");
  });

  it("can force browser smoke checks through the environment", async () => {
    const cwd = await makeProject();
    process.chdir(cwd);
    process.env.AGENT40_BROWSER_SMOKE_TEST = "1";

    await runDoctorCommand();

    expect(browserProbeCalls[0]?.smokeTest).toBe(true);
  });
});
