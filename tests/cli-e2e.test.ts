import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const CLI_ENTRY = path.resolve(process.cwd(), "src/cli.ts");
const TSX_CLI_PATH = require.resolve("tsx/cli");
const tempDirs: string[] = [];

async function makeProject(prefix: string): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(cwd);
  return cwd;
}

async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [TSX_CLI_PATH, CLI_ENTRY, ...args],
      {
        cwd,
        env: {
          ...process.env,
          ...env,
          AGENT40_CLI_ENTRY: CLI_ENTRY
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return `${stdout}${stderr}`;
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error && "stderr" in error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      throw new Error(`${failure.message}\nSTDOUT:\n${failure.stdout ?? ""}\nSTDERR:\n${failure.stderr ?? ""}`);
    }
    throw error;
  }
}

function extractSessionId(output: string): string {
  const match = output.match(/Session:\s+(ses_[a-z0-9]+)/i);
  if (!match?.[1]) {
    throw new Error(`Session id not found in output:\n${output}`);
  }
  return match[1];
}

async function writeJsFixture(cwd: string): Promise<void> {
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "agent40-cli-e2e",
        private: true,
        type: "module",
        scripts: {
          test: "node --test index.test.js"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "index.js"), "export const value = 1;\n", "utf8");
  await fs.writeFile(
    path.join(cwd, "index.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from './index.js';",
      "",
      "test('value is updated', () => {",
      "  assert.equal(value, 2);",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function setRealProvider(cwd: string): Promise<void> {
  const configPath = path.join(cwd, ".agent", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.providers.openai = { enabled: true, apiKeyEnv: "OPENAI_API_KEY", authMode: "oauth", oauthTokenEnv: "OPENAI_OAUTH_TOKEN", defaultModel: "gpt-5.4", timeoutMs: 120000, maxRetries: 2 };
  config.routing = { categories: { planning: "openai", research: "openai", execution: "openai", frontend: "openai", review: "openai" } };
  config.safety = { defaultMode: "auto", autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run", "write", "edit", "bash_side_effect"], requireApproval: ["browser_submit", "git_push"] };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function setTeamMaxWorkers(cwd: string, maxWorkers: number): Promise<void> {
  const configPath = path.join(cwd, ".agent", "config.json");
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as {
    team: { maxWorkers: number };
  };
  config.team.maxWorkers = maxWorkers;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("cli e2e", () => {
  it("runs init, run, status, resume, and doctor through the real CLI", async () => {
    const cwd = await makeProject("agent40-cli-run-");
    const initOutput = await runCli(cwd, ["init"]);
    await setRealProvider(cwd);
    await writeJsFixture(cwd);

    const runOutput = await runCli(
      cwd,
      ["run", "Change index.js so it exports const value to 2 and run npm test"],
      { AGENT40_AUTO_APPROVE: "write,edit" }
    );
    const sessionId = extractSessionId(runOutput);

    expect(initOutput).toContain("Initialized agent40");
    expect(runOutput).toContain("Status: completed");
    expect(runOutput).toContain("Review:");
    expect(await fs.readFile(path.join(cwd, "index.js"), "utf8")).toContain("export const value = 2;");

    const listOutput = await runCli(cwd, ["status"]);
    const detailOutput = await runCli(cwd, ["status", sessionId]);
    const resumeOutput = await runCli(cwd, ["resume", sessionId], { AGENT40_AUTO_APPROVE: "write,edit" });
    const doctorOutput = await runCli(cwd, ["doctor"]);

    expect(listOutput).toContain(sessionId);
    expect(detailOutput).toContain("Status: completed");
    expect(detailOutput).toContain("Tasks:");
    expect(resumeOutput).toContain("Status: completed");
    expect(doctorOutput).toContain("provider:openai");
    expect(doctorOutput).toContain("active roles");
  }, 90_000);

  it("runs team, status, and soak through the real CLI", async () => {
    const cwd = await makeProject("agent40-cli-team-");
    await runCli(cwd, ["init"]);
    await setRealProvider(cwd);
    await fs.writeFile(path.join(cwd, "README.md"), "# Fixture\n\nAuth flow docs.\n", "utf8");
    await fs.writeFile(path.join(cwd, "index.ts"), "export const value = 1;\n", "utf8");
    await setTeamMaxWorkers(cwd, 9);

    const teamOutput = await runCli(
      cwd,
      ["team", "Harden auth security, improve performance and observability, update CI, and prepare a PR summary"]
    );
    const sessionId = extractSessionId(teamOutput);
    const detailOutput = await runCli(cwd, ["status", sessionId]);
    const soakOutput = await runCli(cwd, ["soak", "--rounds", "1"]);

    expect(teamOutput).toContain("Status: completed");
    expect(detailOutput).toContain("Recent delegation:");
    expect(detailOutput).toContain("security-review");
    expect(detailOutput).toContain("observability-plan");
    expect(soakOutput).toContain("openai");
    expect(soakOutput).toContain("anthropic");
    expect(soakOutput).toContain("gemini");
    expect(soakOutput).toContain("report saved to");
  }, 90_000);
});
