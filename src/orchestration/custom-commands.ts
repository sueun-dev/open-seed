/**
 * Custom Command System — OpenCode-style user-defined prompts.
 *
 * Users define commands as markdown files in .agent/commands/:
 *   .agent/commands/deploy.md → /deploy command
 *
 * Supports variable substitution ($TARGET, $ARGS, etc.)
 *
 * Source: OpenCode research — "Custom Commands System"
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  variables: string[];
  filePath: string;
}

/**
 * Discover custom commands from .agent/commands/ directory.
 */
export async function discoverCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];
  const cmdDir = path.join(cwd, ".agent", "commands");

  try {
    const files = await fs.readdir(cmdDir);
    for (const file of files.filter(f => f.endsWith(".md"))) {
      try {
        const content = await fs.readFile(path.join(cmdDir, file), "utf-8");
        const name = file.replace(".md", "");
        const { description, template, variables } = parseCommandTemplate(content);
        commands.push({
          name,
          description,
          template,
          variables,
          filePath: path.join(cmdDir, file)
        });
      } catch { /* skip corrupt files */ }
    }
  } catch { /* no commands dir */ }

  return commands;
}

function parseCommandTemplate(content: string): { description: string; template: string; variables: string[] } {
  const lines = content.split("\n");
  let description = "";
  let template = content;

  // Extract frontmatter-style description
  if (lines[0]?.startsWith("# ")) {
    description = lines[0].replace("# ", "").trim();
    template = lines.slice(1).join("\n").trim();
  } else if (lines[0]?.startsWith("---")) {
    // YAML frontmatter
    const endIdx = lines.indexOf("---", 1);
    if (endIdx > 0) {
      const frontmatter = lines.slice(1, endIdx).join("\n");
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (descMatch) description = descMatch[1].trim();
      template = lines.slice(endIdx + 1).join("\n").trim();
    }
  }

  // Extract $VARIABLES
  const variables: string[] = [];
  const varPattern = /\$([A-Z_][A-Z0-9_]*)/g;
  let match;
  while ((match = varPattern.exec(template)) !== null) {
    if (!variables.includes(match[1])) variables.push(match[1]);
  }

  return { description, template, variables };
}

/**
 * Expand a custom command with provided arguments.
 */
export function expandCommand(command: CustomCommand, args: Record<string, string>): string {
  let expanded = command.template;

  // Replace $VARIABLES
  for (const varName of command.variables) {
    const value = args[varName] ?? args[varName.toLowerCase()] ?? "";
    expanded = expanded.replace(new RegExp(`\\$${varName}`, "g"), value);
  }

  // Replace $ARGS with all arguments joined
  const allArgs = Object.values(args).join(" ");
  expanded = expanded.replace(/\$ARGS/g, allArgs);

  return expanded;
}

/**
 * Format available commands for display.
 */
export function formatCommandList(commands: CustomCommand[]): string {
  if (commands.length === 0) return "No custom commands found. Create .agent/commands/<name>.md to add one.";

  return commands.map(cmd =>
    `  /${cmd.name}${cmd.variables.length > 0 ? ` [${cmd.variables.map(v => `$${v}`).join(", ")}]` : ""} — ${cmd.description || "(no description)"}`
  ).join("\n");
}
