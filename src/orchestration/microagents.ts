/**
 * Microagent System (inspired by OpenHands).
 *
 * Microagents are markdown files with YAML frontmatter that get auto-injected
 * into the system prompt when certain keywords appear in the user's task.
 *
 * Three types:
 * - KNOWLEDGE: triggered by keywords, injected as context
 * - REPO_KNOWLEDGE: always active for the repo (like .cursorrules, AGENTS.md)
 * - TASK: parameterized workflows with inputs
 *
 * Files are loaded from:
 * - .agent/microagents/*.md
 * - .cursorrules (auto-detected as REPO_KNOWLEDGE)
 * - AGENTS.md (auto-detected as REPO_KNOWLEDGE)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../core/utils.js";

export type MicroagentType = "knowledge" | "repo_knowledge" | "task";

export interface Microagent {
  name: string;
  type: MicroagentType;
  triggers: string[];
  content: string;
  filePath: string;
}

export interface MicroagentRegistry {
  agents: Microagent[];
}

/**
 * Load all microagents from the workspace.
 */
export async function loadMicroagents(cwd: string): Promise<MicroagentRegistry> {
  const agents: Microagent[] = [];

  // Load from .agent/microagents/*.md
  const microagentDir = path.join(cwd, ".agent", "microagents");
  try {
    const files = await fs.readdir(microagentDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(microagentDir, file);
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseMicroagent(content, filePath);
      if (parsed) agents.push(parsed);
    }
  } catch {
    // Directory doesn't exist — that's fine
  }

  // Auto-detect repo knowledge files
  const repoKnowledgeFiles = [
    ".cursorrules",
    ".clinerules",
    "AGENTS.md",
    ".github/copilot-instructions.md"
  ];

  for (const relPath of repoKnowledgeFiles) {
    const filePath = path.join(cwd, relPath);
    if (await fileExists(filePath)) {
      const content = await fs.readFile(filePath, "utf8");
      agents.push({
        name: path.basename(relPath, path.extname(relPath)),
        type: "repo_knowledge",
        triggers: [],
        content,
        filePath
      });
    }
  }

  return { agents };
}

/**
 * Get all microagents that should be active for a given task.
 * - All REPO_KNOWLEDGE agents are always active
 * - KNOWLEDGE agents are active if any trigger matches the task text
 * - TASK agents are active if the task explicitly references them
 */
export function getActiveMicroagents(registry: MicroagentRegistry, task: string): Microagent[] {
  const taskLower = task.toLowerCase();
  const active: Microagent[] = [];

  for (const agent of registry.agents) {
    if (agent.type === "repo_knowledge") {
      active.push(agent);
      continue;
    }

    if (agent.type === "knowledge" && agent.triggers.length > 0) {
      const triggered = agent.triggers.some((trigger) =>
        taskLower.includes(trigger.toLowerCase())
      );
      if (triggered) {
        active.push(agent);
      }
      continue;
    }

    if (agent.type === "task") {
      // Task agents are triggered by explicit @mention or name reference
      if (taskLower.includes(`@${agent.name.toLowerCase()}`) ||
          taskLower.includes(agent.name.toLowerCase())) {
        active.push(agent);
      }
    }
  }

  return active;
}

/**
 * Build the combined context string from active microagents.
 */
export function buildMicroagentContext(agents: Microagent[]): string {
  if (agents.length === 0) return "";

  const sections: string[] = [];

  const repoKnowledge = agents.filter((a) => a.type === "repo_knowledge");
  const knowledge = agents.filter((a) => a.type === "knowledge");
  const tasks = agents.filter((a) => a.type === "task");

  if (repoKnowledge.length > 0) {
    sections.push(
      "# Repository Knowledge\n\n" +
      repoKnowledge.map((a) => `## ${a.name}\n${a.content}`).join("\n\n")
    );
  }

  if (knowledge.length > 0) {
    sections.push(
      "# Triggered Knowledge\n\n" +
      knowledge.map((a) => `## ${a.name}\n${a.content}`).join("\n\n")
    );
  }

  if (tasks.length > 0) {
    sections.push(
      "# Task Templates\n\n" +
      tasks.map((a) => `## ${a.name}\n${a.content}`).join("\n\n")
    );
  }

  return sections.join("\n\n");
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseMicroagent(content: string, filePath: string): Microagent | null {
  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    // No frontmatter — treat as repo knowledge
    return {
      name: path.basename(filePath, ".md"),
      type: "repo_knowledge",
      triggers: [],
      content,
      filePath
    };
  }

  const frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2];

  const name = extractField(frontmatter, "name") ?? path.basename(filePath, ".md");
  const type = (extractField(frontmatter, "type") ?? "knowledge") as MicroagentType;
  const triggersStr = extractField(frontmatter, "triggers");
  const triggers = triggersStr
    ? triggersStr.split(",").map((t) => t.trim()).filter(Boolean)
    : extractListField(frontmatter, "triggers");

  return { name, type, triggers, content: body.trim(), filePath };
}

function extractField(yaml: string, field: string): string | undefined {
  const match = yaml.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function extractListField(yaml: string, field: string): string[] {
  const items: string[] = [];
  const blockMatch = yaml.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, "m"));
  if (blockMatch) {
    for (const line of blockMatch[1].split("\n")) {
      const item = line.replace(/^\s*-\s*/, "").trim();
      if (item) items.push(item.replace(/^["']|["']$/g, ""));
    }
  }
  return items;
}
