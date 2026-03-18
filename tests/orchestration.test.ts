import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runEngine } from "../src/orchestration/engine.js";
import { createDefaultConfig } from "../src/core/config.js";
import { writeDefaultConfig } from "../src/core/config.js";
import { detectTmuxAvailability, LocalWorkerManager } from "../src/orchestration/worker-manager.js";
import { summarizeSessionActivity } from "../src/sessions/activity.js";
import { SessionStore } from "../src/sessions/store.js";

const tempDirs: string[] = [];
const originalEntry = process.env.AGENT40_CLI_ENTRY;

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-orch-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  // Use real OpenAI via OAuth for tests — no mock
  const configPath = path.join(cwd, ".agent", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.providers.openai = { enabled: true, apiKeyEnv: "OPENAI_API_KEY", authMode: "oauth", oauthTokenEnv: "OPENAI_OAUTH_TOKEN", defaultModel: "gpt-5.4", timeoutMs: 120000, maxRetries: 2 };
  config.routing = { categories: { planning: "openai", research: "openai", execution: "openai", frontend: "openai", review: "openai" } };
  config.safety = { defaultMode: "auto", autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run", "write", "edit", "bash_side_effect"], requireApproval: ["browser_submit", "git_push"] };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS\n\n- Test context", "utf8");
  await fs.writeFile(path.join(cwd, "index.ts"), "export const value = 1;\n", "utf8");
  return cwd;
}

async function makeJsProjectWithTests(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-orch-js-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  // Use real OpenAI via OAuth
  const configPath = path.join(cwd, ".agent", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.providers.openai = { enabled: true, apiKeyEnv: "OPENAI_API_KEY", authMode: "oauth", oauthTokenEnv: "OPENAI_OAUTH_TOKEN", defaultModel: "gpt-5.4", timeoutMs: 120000, maxRetries: 2 };
  config.routing = { categories: { planning: "openai", research: "openai", execution: "openai", frontend: "openai", review: "openai" } };
  config.safety = { defaultMode: "auto", autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run", "write", "edit", "bash_side_effect"], requireApproval: ["browser_submit", "git_push"] };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS\n\n- Test context", "utf8");
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "agent40-fixture",
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
  return cwd;
}

async function makeSpecialistProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-orch-specialist-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS\n\n- Test context", "utf8");
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "agent40-specialist-fixture",
        private: true,
        type: "module",
        scripts: {
          test: "node --test smoke.test.js",
          build: "node -e \"console.log('build ok')\""
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "README.md"), "# Fixture\n\nAuth flow docs.\n", "utf8");
  await fs.writeFile(path.join(cwd, "smoke.test.js"), "import test from 'node:test';\n\ntest('smoke', () => {});\n", "utf8");
  return cwd;
}

async function enableWriteAutoApproval(cwd: string): Promise<void> {
  const configPath = path.join(cwd, ".agent", "config.json");
  const config = createDefaultConfig();
  config.safety.autoApprove = [...config.safety.autoApprove, "write", "edit"];
  config.safety.requireApproval = config.safety.requireApproval.filter((action) => action !== "write" && action !== "edit");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function forceMockProviders(cwd: string): Promise<void> {
  const configPath = path.join(cwd, ".agent", "config.json");
  const config = createDefaultConfig();
  config.providers.anthropic.enabled = false;
  config.providers.openai.enabled = false;
  config.providers.gemini.enabled = false;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function setTeamMaxWorkers(cwd: string, maxWorkers: number): Promise<void> {
  const configPath = path.join(cwd, ".agent", "config.json");
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as ReturnType<typeof createDefaultConfig>;
  config.team.maxWorkers = maxWorkers;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

beforeEach(() => {
  process.env.AGENT40_CLI_ENTRY = path.resolve("/Users/bentley/Documents/codebase/mygent/src/cli.ts");
});

afterEach(async () => {
  process.env.AGENT40_CLI_ENTRY = originalEntry;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("orchestration engine", { timeout: 180_000 }, () => {
  it("runs in inline mode with real LLM", async () => {
    const cwd = await makeProject();
    const result = await runEngine({
      cwd,
      task: "Plan and implement a safe refactor",
      mode: "run"
    });
    expect(result.session.status).toBe("completed");
    expect(result.review.verdict).toBe("pass");
  });

  it("runs in team mode with subprocess fallback when tmux is unavailable", async () => {
    const cwd = await makeProject();
    const tmuxAvailable = detectTmuxAvailability();
    if (tmuxAvailable) {
      return;
    }
    const result = await runEngine({
      cwd,
      task: "Investigate the auth flow and summarize findings",
      mode: "team"
    });
    expect(result.session.status).toBe("completed");
    expect(result.review.verdict).toBe("pass");
  }, 30_000);

  it("delegates planned work to specialist roles in team mode", async () => {
    const cwd = await makeSpecialistProject();
    await forceMockProviders(cwd);
    await enableWriteAutoApproval(cwd);
    const tmuxAvailable = detectTmuxAvailability();
    if (tmuxAvailable) {
      return;
    }

    const result = await runEngine({
      cwd,
      task: "Fix the build, add tests, and update docs for the auth flow",
      mode: "team"
    });

    expect(result.session.status).toBe("completed");
    const specialistRoles = result.session.tasks.map((task) => task.role);
    expect(specialistRoles).toContain("build-doctor");
    expect(specialistRoles).toContain("test-engineer");
    expect(specialistRoles).toContain("docs-writer");

    const store = new SessionStore(cwd, createDefaultConfig().sessions);
    const events = await store.readEvents(result.session.id);
    expect(events.some((event) => event.type === "delegation.started")).toBe(true);
    expect(events.some((event) => event.type === "delegation.completed")).toBe(true);
    expect(
      events.some((event) =>
        event.type === "delegation.completed"
        && event.payload.role === "build-doctor"
        && event.payload.contractKind === "build-plan"
      )
    ).toBe(true);

    const artifactKinds = await Promise.all(
      result.session.tasks
        .filter((task) => ["build-doctor", "test-engineer", "docs-writer"].includes(task.role))
        .map(async (task) => ({
          role: task.role,
          artifact: await store.readArtifact(task.id)
        }))
    );
    expect(artifactKinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "build-doctor", artifact: expect.objectContaining({ kind: "build-plan" }) }),
        expect.objectContaining({ role: "test-engineer", artifact: expect.objectContaining({ kind: "test-plan" }) }),
        expect.objectContaining({ role: "docs-writer", artifact: expect.objectContaining({ kind: "documentation-plan" }) })
      ])
    );

    const activity = summarizeSessionActivity(result.session, events, []);
    expect(activity.delegationNotes.some((note) => note.role === "build-doctor")).toBe(true);
    expect(activity.delegationNotes.some((note) => note.contractKind === "build-plan")).toBe(true);
  }, 30_000);

  it("persists inferred specialist contracts for root-task signals", async () => {
    const cwd = await makeSpecialistProject();
    await forceMockProviders(cwd);
    await enableWriteAutoApproval(cwd);
    await setTeamMaxWorkers(cwd, 9);
    const tmuxAvailable = detectTmuxAvailability();
    if (tmuxAvailable) {
      return;
    }

    const result = await runEngine({
      cwd,
      task: "Harden auth security, improve performance and observability, update CI, shape git strategy, and prepare a PR summary",
      mode: "team"
    });

    const specialistRoles = result.session.tasks.map((task) => task.role);
    expect(specialistRoles).toEqual(
      expect.arrayContaining([
        "security-auditor",
        "performance-engineer",
        "observability-engineer",
        "cicd-engineer",
        "git-strategist",
        "pr-author"
      ])
    );

    const store = new SessionStore(cwd, createDefaultConfig().sessions);
    const artifacts = await Promise.all(
      result.session.tasks
        .filter((task) =>
          ["security-auditor", "performance-engineer", "observability-engineer", "cicd-engineer", "git-strategist", "pr-author"]
            .includes(task.role)
        )
        .map(async (task) => ({
          role: task.role,
          artifact: await store.readArtifact(task.id)
        }))
    );

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "security-auditor", artifact: expect.objectContaining({ kind: "security-review" }) }),
        expect.objectContaining({ role: "performance-engineer", artifact: expect.objectContaining({ kind: "performance-plan" }) }),
        expect.objectContaining({ role: "observability-engineer", artifact: expect.objectContaining({ kind: "observability-plan" }) }),
        expect.objectContaining({ role: "cicd-engineer", artifact: expect.objectContaining({ kind: "cicd-plan" }) }),
        expect.objectContaining({ role: "git-strategist", artifact: expect.objectContaining({ kind: "git-plan" }) }),
        expect.objectContaining({ role: "pr-author", artifact: expect.objectContaining({ kind: "pr-plan" }) })
      ])
    );

    const events = await store.readEvents(result.session.id);
    const activity = summarizeSessionActivity(result.session, events, []);
    expect(activity.delegationNotes.some((note) => note.contractKind === "security-review")).toBe(true);
    expect(activity.delegationNotes.some((note) => note.contractKind === "pr-plan")).toBe(true);
  }, 30_000);

  it("selects subprocess transport outside tmux", () => {
    const manager = new LocalWorkerManager(5);
    expect(manager.selectTransport(true)).toBe(detectTmuxAvailability() ? "tmux" : "subprocess");
  });

  it("executes approved tool calls and mutates the workspace", async () => {
    const cwd = await makeProject();
    await enableWriteAutoApproval(cwd);

    const result = await runEngine({
      cwd,
      task: "Change index.ts so it exports const value to 2",
      mode: "run"
    });

    expect(result.session.status).toBe("completed");
    expect(await fs.readFile(path.join(cwd, "index.ts"), "utf8")).toContain("export const value = 2;");
  });

  it("runs safe test commands as part of execution verification", async () => {
    const cwd = await makeJsProjectWithTests();
    await enableWriteAutoApproval(cwd);

    const result = await runEngine({
      cwd,
      task: "Change index.js so it exports const value to 2 and run npm test",
      mode: "run"
    });

    expect(result.session.status).toBe("completed");
    expect(await fs.readFile(path.join(cwd, "index.js"), "utf8")).toContain("export const value = 2;");
  });

  it("records provider stream events during inline execution", async () => {
    const cwd = await makeProject();
    const result = await runEngine({
      cwd,
      task: "Plan and summarize repository status",
      mode: "run"
    });
    const store = new SessionStore(cwd, createDefaultConfig().sessions);
    const events = await store.readEvents(result.session.id);

    expect(events.some((event) => event.type === "provider.stream")).toBe(true);
  });
});
