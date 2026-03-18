/**
 * /init-deep: Hierarchical AGENTS.md generator.
 *
 * Scans the repository structure, identifies meaningful directories,
 * and generates scoped AGENTS.md files at each level with context
 * about what lives there, key patterns, and constraints.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { getLanguageFromPath, fileExists } from "../core/utils.js";
import { buildRepoMap } from "../tools/repomap.js";
import type { RepoMapEntry } from "../core/types.js";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".agent", "dist", "coverage", ".next",
  ".turbo", ".cache", "__pycache__", ".venv", "venv", "build",
  ".output", ".nuxt", ".svelte-kit"
]);

interface DirectoryProfile {
  relativePath: string;
  absolutePath: string;
  files: RepoMapEntry[];
  subdirectories: string[];
  dominantLanguage: string;
  purpose: string;
  patterns: string[];
  depth: number;
}

export async function runInitDeepCommand(): Promise<void> {
  const cwd = process.cwd();
  console.log("Scanning repository structure...");

  const repoMap = await buildRepoMap(cwd);
  const profiles = buildDirectoryProfiles(cwd, repoMap);

  let generated = 0;
  for (const profile of profiles) {
    const agentsPath = path.join(profile.absolutePath, "AGENTS.md");
    if (await fileExists(agentsPath)) {
      console.log(`  skip ${profile.relativePath || "."}/AGENTS.md (already exists)`);
      continue;
    }
    const content = generateAgentsMd(profile);
    await fs.writeFile(agentsPath, content, "utf8");
    console.log(`  wrote ${profile.relativePath || "."}/AGENTS.md`);
    generated += 1;
  }

  console.log(`\nGenerated ${generated} AGENTS.md file(s). Review and customize them.`);
}

function buildDirectoryProfiles(cwd: string, repoMap: RepoMapEntry[]): DirectoryProfile[] {
  const dirMap = new Map<string, RepoMapEntry[]>();

  for (const entry of repoMap) {
    if (entry.kind !== "file") continue;
    const dir = path.dirname(entry.path);
    if (!dirMap.has(dir)) {
      dirMap.set(dir, []);
    }
    dirMap.get(dir)!.push(entry);
  }

  const profiles: DirectoryProfile[] = [];

  // Always include root
  profiles.push(createProfile(cwd, ".", repoMap.filter((e) => path.dirname(e.path) === "."), dirMap));

  // Include meaningful subdirectories (depth 1-2)
  for (const [dir, files] of dirMap.entries()) {
    if (dir === ".") continue;
    const depth = dir.split("/").length;
    if (depth > 2) continue;
    if (files.length < 2) continue;
    if (SKIP_DIRS.has(dir.split("/")[0])) continue;

    const subdirs = Array.from(dirMap.keys())
      .filter((d) => d.startsWith(`${dir}/`) && d.split("/").length === depth + 1);

    profiles.push(createProfile(cwd, dir, files, dirMap, subdirs));
  }

  return profiles.sort((a, b) => a.depth - b.depth);
}

function createProfile(
  cwd: string,
  relativePath: string,
  files: RepoMapEntry[],
  dirMap: Map<string, RepoMapEntry[]>,
  subdirectories?: string[]
): DirectoryProfile {
  const depth = relativePath === "." ? 0 : relativePath.split("/").length;
  const subdirs = subdirectories ?? Array.from(dirMap.keys())
    .filter((d) => {
      if (relativePath === ".") {
        return !d.includes("/") && d !== ".";
      }
      return d.startsWith(`${relativePath}/`) && d.split("/").length === depth + 1;
    })
    .filter((d) => !SKIP_DIRS.has(d.split("/").pop()!));

  const languages = files.map((f) => f.language).filter((l) => l !== "text" && l !== "json" && l !== "markdown");
  const langCounts = new Map<string, number>();
  for (const lang of languages) {
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
  }
  const dominantLanguage = Array.from(langCounts.entries())
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "mixed";

  return {
    relativePath,
    absolutePath: relativePath === "." ? cwd : path.join(cwd, relativePath),
    files,
    subdirectories: subdirs,
    dominantLanguage,
    purpose: inferPurpose(relativePath, files),
    patterns: inferPatterns(relativePath, files),
    depth
  };
}

function inferPurpose(relativePath: string, files: RepoMapEntry[]): string {
  const dir = relativePath.split("/").pop() ?? relativePath;
  const fileNames = files.map((f) => path.basename(f.path).toLowerCase());

  if (dir === "." || dir === "") {
    return "Project root — top-level configuration, entry points, and documentation.";
  }
  if (/^(commands?|cmd)$/.test(dir)) {
    return "CLI command implementations.";
  }
  if (/^(orchestrat|engine)/.test(dir)) {
    return "Orchestration engine, delegation logic, and worker management.";
  }
  if (/^providers?$/.test(dir)) {
    return "Provider adapters, authentication, and routing.";
  }
  if (/^roles?$/.test(dir)) {
    return "Role registry and role-specific prompt configuration.";
  }
  if (/^sessions?$/.test(dir)) {
    return "Session persistence, event logging, and status tracking.";
  }
  if (/^tools?$/.test(dir)) {
    return "Tool implementations: file I/O, search, browser, LSP, and code intelligence.";
  }
  if (/^(safety|approval)$/.test(dir)) {
    return "Approval policies and safety gating.";
  }
  if (/^(routing|policy)$/.test(dir)) {
    return "Task classification and provider routing policies.";
  }
  if (/^(soak|bench)/.test(dir)) {
    return "Provider soak testing and benchmarking harness.";
  }
  if (/^(core|lib|utils?)$/.test(dir)) {
    return "Shared types, utilities, and configuration.";
  }
  if (/^(test|spec|__test)/.test(dir)) {
    return "Test suites and test fixtures.";
  }
  if (/^(component|ui|view|page)/.test(dir)) {
    return "UI components and views.";
  }
  if (/^(api|route|handler|controller)/.test(dir)) {
    return "API routes, handlers, and controllers.";
  }
  if (/^(model|schema|entity|db|migration)/.test(dir)) {
    return "Data models, schemas, and database migrations.";
  }
  if (/^(middleware|plugin|hook)/.test(dir)) {
    return "Middleware, plugins, and hooks.";
  }
  if (/^(config|setting)/.test(dir)) {
    return "Application configuration.";
  }

  // fallback: describe by content
  if (fileNames.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))) {
    return "Test files for this module.";
  }
  return `Module containing ${files.length} file(s) in ${dir}.`;
}

function inferPatterns(relativePath: string, files: RepoMapEntry[]): string[] {
  const patterns: string[] = [];
  const symbols = files.flatMap((f) => f.symbols);

  if (files.some((f) => f.path.endsWith(".test.ts") || f.path.endsWith(".spec.ts"))) {
    patterns.push("Test files co-locate with source or live under tests/.");
  }
  if (symbols.some((s) => /^export (async )?function/.test(s) || s.startsWith("export class"))) {
    patterns.push("Modules export functions and classes directly.");
  }
  if (files.some((f) => path.basename(f.path) === "index.ts" || path.basename(f.path) === "index.js")) {
    patterns.push("Uses barrel index file for re-exports.");
  }
  if (files.length > 8) {
    patterns.push(`Large module (${files.length} files) — consider grouping changes.`);
  }

  return patterns;
}

function generateAgentsMd(profile: DirectoryProfile): string {
  const lines: string[] = [];
  const title = profile.relativePath === "." ? "Project Root" : profile.relativePath;

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(profile.purpose);
  lines.push("");

  if (profile.dominantLanguage !== "mixed") {
    lines.push(`Primary language: ${profile.dominantLanguage}`);
    lines.push("");
  }

  if (profile.subdirectories.length > 0) {
    lines.push("## Structure");
    lines.push("");
    for (const sub of profile.subdirectories) {
      const subName = sub.split("/").pop() ?? sub;
      lines.push(`- \`${subName}/\` — see ${sub}/AGENTS.md for scoped instructions`);
    }
    lines.push("");
  }

  if (profile.patterns.length > 0) {
    lines.push("## Patterns");
    lines.push("");
    for (const pattern of profile.patterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push("");
  }

  if (profile.files.length > 0 && profile.files.length <= 20) {
    lines.push("## Key files");
    lines.push("");
    for (const file of profile.files.slice(0, 15)) {
      const name = path.basename(file.path);
      const symbolSummary = file.symbols.length > 0
        ? ` — exports: ${file.symbols.slice(0, 4).join(", ")}${file.symbols.length > 4 ? ", ..." : ""}`
        : "";
      lines.push(`- \`${name}\`${symbolSummary}`);
    }
    lines.push("");
  }

  lines.push("## Conventions");
  lines.push("");
  lines.push("- Add project-specific conventions, constraints, and context here.");
  lines.push("- These instructions are loaded hierarchically by the orchestration engine.");
  lines.push("");

  return lines.join("\n");
}
