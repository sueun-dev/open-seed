import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fileExists } from "../core/utils.js";

const FALLBACK_REFERENCE_CONTEXT = [
  "Design references distilled from the surveyed GitHub agents.",
  "Terminal UX and resumable sessions: Codex, Claude Code, Crush, Gemini CLI, OpenCode lineage.",
  "Real multi-agent orchestration and tmux workers: oh-my-openagent, oh-my-claudecode.",
  "Repo mapping and codebase context: Aider, OpenHands.",
  "Browser and verification loop: Cline, OpenClaw.",
  "Extensibility and multi-provider routing: Goose, Continue, Crush, OpenClaw.",
  "Reference set includes: oh-my-openagent, oh-my-claudecode, OpenClaw, OpenCode, Crush, Codex, Claude Code, Gemini CLI, Goose, Aider, Cline, Roo Code, Kilo Code, Continue, OpenHands, SWE-agent, Tabby, Cursor, Windsurf, Devin, Amp, Copilot coding agent."
].join("\n");

let cachedContext: string | null = null;

export async function loadDesignReferenceContext(): Promise<string> {
  if (cachedContext) {
    return cachedContext;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(currentFile), "..", "..");
  const surveyPath = path.join(projectRoot, ".research", "ultimate-agent-feature-list-2026-03-16.md");
  if (await fileExists(surveyPath)) {
    const raw = await fs.readFile(surveyPath, "utf8");
    const sections = raw
      .split("\n")
      .slice(0, 80)
      .join("\n")
      .trim();
    cachedContext = `# Reference Context\n${sections}`;
    return cachedContext;
  }

  cachedContext = `# Reference Context\n${FALLBACK_REFERENCE_CONTEXT}`;
  return cachedContext;
}
