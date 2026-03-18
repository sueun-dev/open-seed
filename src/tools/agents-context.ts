import fs from "node:fs/promises";
import path from "node:path";

import { fileExists } from "../core/utils.js";

export async function loadAgentsContext(cwd: string, targetPaths: string[] = []): Promise<string> {
  const segments = new Set<string>([cwd]);
  for (const target of targetPaths) {
    let current = path.resolve(cwd, target);
    while (current.startsWith(cwd)) {
      segments.add(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
      if (current === cwd) {
        segments.add(current);
        break;
      }
    }
  }

  const ordered = Array.from(segments).sort((a, b) => a.length - b.length);
  const blocks: string[] = [];
  for (const directory of ordered) {
    const candidate = path.join(directory, "AGENTS.md");
    if (!(await fileExists(candidate))) {
      continue;
    }
    const content = await fs.readFile(candidate, "utf8");
    blocks.push(`# Context from ${path.relative(cwd, candidate) || "AGENTS.md"}\n${content.trim()}`);
  }
  return blocks.join("\n\n");
}
