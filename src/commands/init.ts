import fs from "node:fs/promises";
import path from "node:path";

import { writeDefaultConfig } from "../core/config.js";
import { getProjectAgentDir } from "../core/paths.js";
import { fileExists } from "../core/utils.js";

export async function runInitCommand(): Promise<void> {
  const cwd = process.cwd();
  const configPath = await writeDefaultConfig(cwd);
  const rootAgentsPath = path.join(cwd, "AGENTS.md");
  if (!(await fileExists(rootAgentsPath))) {
    await fs.writeFile(
      rootAgentsPath,
      [
        "# AGENTS",
        "",
        "- Project-wide instructions live here.",
        "- Add coding conventions, constraints, and context for agent40."
      ].join("\n"),
      "utf8"
    );
  }
  console.log(`Initialized agent40 at ${getProjectAgentDir(cwd)}`);
  console.log(`Config written to ${configPath}`);
}
