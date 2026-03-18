import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadMicroagents, getActiveMicroagents, buildMicroagentContext } from "../src/orchestration/microagents.js";

describe("Microagents", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-microagent-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads microagent from .agent/microagents/ with frontmatter", async () => {
    const dir = path.join(tmpDir, ".agent", "microagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "docker.md"), `---
name: docker-helper
type: knowledge
triggers: docker, container, dockerfile
---
When working with Docker, always use multi-stage builds.
`);

    const registry = await loadMicroagents(tmpDir);
    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0].name).toBe("docker-helper");
    expect(registry.agents[0].type).toBe("knowledge");
    expect(registry.agents[0].triggers).toContain("docker");
    expect(registry.agents[0].content).toContain("multi-stage builds");
  });

  it("auto-detects .cursorrules as repo_knowledge", async () => {
    await fs.writeFile(path.join(tmpDir, ".cursorrules"), "Always use TypeScript strict mode.");

    const registry = await loadMicroagents(tmpDir);
    const repoAgents = registry.agents.filter((a) => a.type === "repo_knowledge");
    expect(repoAgents.length).toBeGreaterThanOrEqual(1);
    expect(repoAgents[0].content).toContain("TypeScript strict mode");
  });

  it("triggers knowledge microagent based on keywords", async () => {
    const dir = path.join(tmpDir, ".agent", "microagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "react.md"), `---
name: react-guide
type: knowledge
triggers: react, component, jsx
---
Use functional components with hooks.
`);
    await fs.writeFile(path.join(dir, "database.md"), `---
name: db-guide
type: knowledge
triggers: database, sql, postgres
---
Always use parameterized queries.
`);

    const registry = await loadMicroagents(tmpDir);
    const active = getActiveMicroagents(registry, "Create a React component for the dashboard");
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("react-guide");
  });

  it("repo_knowledge agents are always active", async () => {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "This is the project agent guide.");

    const registry = await loadMicroagents(tmpDir);
    const active = getActiveMicroagents(registry, "Fix a bug in the login page");
    const repoKnowledge = active.filter((a) => a.type === "repo_knowledge");
    expect(repoKnowledge.length).toBeGreaterThanOrEqual(1);
  });

  it("builds combined context from active microagents", async () => {
    const dir = path.join(tmpDir, ".agent", "microagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "test.md"), `---
name: testing-guide
type: knowledge
triggers: test, testing
---
Always write tests for new functions.
`);
    await fs.writeFile(path.join(tmpDir, ".cursorrules"), "Use strict mode.");

    const registry = await loadMicroagents(tmpDir);
    const active = getActiveMicroagents(registry, "Add tests for the new feature");
    const context = buildMicroagentContext(active);
    expect(context).toContain("Repository Knowledge");
    expect(context).toContain("Triggered Knowledge");
    expect(context).toContain("testing-guide");
  });

  it("returns empty context when no agents loaded", async () => {
    const registry = await loadMicroagents(tmpDir);
    const active = getActiveMicroagents(registry, "Do something");
    const context = buildMicroagentContext(active);
    expect(context).toBe("");
  });
});
