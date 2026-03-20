/**
 * Incremental Dependency Graph — understands what breaks when you change a file.
 *
 * Tracks import relationships between files:
 * - When you edit file A, shows all files that import A
 * - Predicts side effects across the dependency tree
 * - Auto-loads dependent files into context
 * - Prevents cascading failures
 *
 * Source: Cline + Continue + Plandex patterns
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface DependencyNode {
  file: string;
  imports: string[];      // files this file imports
  importedBy: string[];   // files that import this file
  language: string;
  lastModified: number;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  buildTime: number;
}

export interface ImpactAnalysis {
  directDependents: string[];
  transitiveDependents: string[];
  totalImpact: number;
  riskLevel: "low" | "medium" | "high";
  suggestedFilesToLoad: string[];
}

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+(?:[\w{},*\s]+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+(?:[\w{},*\s]+)\s+from\s+['"]([^'"]+)['"]/g,
  ],
  python: [
    /from\s+([\w.]+)\s+import/g,
    /import\s+([\w.]+)/g,
  ],
  go: [
    /import\s+(?:\w+\s+)?"([^"]+)"/g,
    /import\s+\(\s*(?:\w+\s+)?"([^"]+)"/g,
  ],
  rust: [
    /use\s+([\w:]+)/g,
    /mod\s+(\w+)/g,
  ],
};

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".agent", ".research", "__pycache__", "venv", ".next", "build"]);

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if ([".py"].includes(ext)) return "python";
  if ([".go"].includes(ext)) return "go";
  if ([".rs"].includes(ext)) return "rust";
  return "unknown";
}

function resolveImportPath(importPath: string, fromFile: string, cwd: string): string | null {
  // Handle relative imports
  if (importPath.startsWith(".")) {
    const dir = path.dirname(fromFile);
    let resolved = path.resolve(cwd, dir, importPath);

    // Try with extensions
    const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
    for (const ext of extensions) {
      const withExt = resolved + ext;
      const rel = path.relative(cwd, withExt);
      if (!rel.startsWith("..")) return rel;
    }
    // Try without extension (already has one)
    const rel = path.relative(cwd, resolved);
    if (!rel.startsWith("..")) return rel;
  }

  // Handle package imports (node_modules) — skip these
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;

  return null;
}

function extractImports(content: string, filePath: string, cwd: string): string[] {
  const language = detectLanguage(filePath);
  const patterns = IMPORT_PATTERNS[language];
  if (!patterns) return [];

  const imports: string[] = [];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      if (!importPath) continue;

      const resolved = resolveImportPath(importPath, filePath, cwd);
      if (resolved) imports.push(resolved);
    }
  }

  return [...new Set(imports)];
}

/**
 * Build dependency graph for the entire project.
 */
export async function buildDependencyGraph(cwd: string): Promise<DependencyGraph> {
  const startTime = Date.now();
  const nodes = new Map<string, DependencyNode>();

  await walkAndParse(cwd, cwd, nodes);

  // Build reverse dependencies (importedBy)
  for (const [file, node] of nodes) {
    for (const imp of node.imports) {
      const target = nodes.get(imp);
      if (target && !target.importedBy.includes(file)) {
        target.importedBy.push(file);
      }
    }
  }

  return { nodes, buildTime: Date.now() - startTime };
}

async function walkAndParse(root: string, dir: string, nodes: Map<string, DependencyNode>, depth = 0): Promise<void> {
  if (depth > 8) return;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);

      if (entry.isDirectory()) {
        await walkAndParse(root, full, nodes, depth + 1);
      } else if (entry.isFile()) {
        const language = detectLanguage(rel);
        if (language === "unknown") continue;

        try {
          const content = await fs.readFile(full, "utf-8");
          const stat = await fs.stat(full);
          const imports = extractImports(content, rel, root);

          nodes.set(rel, {
            file: rel,
            imports,
            importedBy: [],
            language,
            lastModified: stat.mtimeMs
          });
        } catch { /* unreadable */ }
      }
    }
  } catch { /* permission denied */ }
}

/**
 * Analyze impact of changing a specific file.
 */
export function analyzeImpact(graph: DependencyGraph, changedFile: string): ImpactAnalysis {
  const direct = new Set<string>();
  const transitive = new Set<string>();

  // BFS for all dependents
  const queue = [changedFile];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const node = graph.nodes.get(current);
    if (!node) continue;

    for (const dep of node.importedBy) {
      if (dep === changedFile) continue;
      if (!visited.has(dep)) {
        if (current === changedFile) direct.add(dep);
        else transitive.add(dep);
        queue.push(dep);
      }
    }
  }

  const totalImpact = direct.size + transitive.size;
  const riskLevel: ImpactAnalysis["riskLevel"] =
    totalImpact > 20 ? "high" :
    totalImpact > 5 ? "medium" : "low";

  // Suggest loading direct dependents + the file's own imports
  const node = graph.nodes.get(changedFile);
  const suggestedFilesToLoad = [
    ...Array.from(direct).slice(0, 5),
    ...(node?.imports ?? []).slice(0, 5)
  ];

  return {
    directDependents: Array.from(direct),
    transitiveDependents: Array.from(transitive),
    totalImpact,
    riskLevel,
    suggestedFilesToLoad: [...new Set(suggestedFilesToLoad)]
  };
}

/**
 * Get files that should be loaded into context when editing a file.
 */
export function getContextFilesForEdit(graph: DependencyGraph, targetFile: string, maxFiles = 10): string[] {
  const node = graph.nodes.get(targetFile);
  if (!node) return [];

  const files = new Set<string>();

  // Add direct imports
  for (const imp of node.imports) {
    files.add(imp);
  }

  // Add direct dependents (files that import this file)
  for (const dep of node.importedBy) {
    files.add(dep);
  }

  // Add shared imports (files imported by dependents)
  for (const dep of node.importedBy.slice(0, 3)) {
    const depNode = graph.nodes.get(dep);
    if (depNode) {
      for (const imp of depNode.imports.slice(0, 2)) {
        files.add(imp);
      }
    }
  }

  files.delete(targetFile);
  return Array.from(files).slice(0, maxFiles);
}

export function formatImpactAnalysis(analysis: ImpactAnalysis, fileName: string): string {
  return [
    `## Impact Analysis: ${fileName}`,
    `Risk: ${analysis.riskLevel.toUpperCase()} (${analysis.totalImpact} files affected)`,
    `Direct dependents (${analysis.directDependents.length}): ${analysis.directDependents.slice(0, 5).join(", ")}`,
    analysis.transitiveDependents.length > 0
      ? `Transitive (${analysis.transitiveDependents.length}): ${analysis.transitiveDependents.slice(0, 3).join(", ")}...`
      : "",
    `Load into context: ${analysis.suggestedFilesToLoad.join(", ")}`
  ].filter(Boolean).join("\n");
}
