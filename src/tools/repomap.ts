/**
 * PageRank-based Repository Map (inspired by aider).
 *
 * Instead of just listing files, this builds a symbol graph and ranks files
 * by importance using a simplified PageRank algorithm:
 *
 * 1. Extract symbol definitions and references from all source files
 * 2. Build a directed graph where edges represent cross-file references
 * 3. Apply PageRank with personalization toward active/mentioned files
 * 4. Return top-ranked entries within a token budget
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { RepoMapEntry } from "../core/types.js";
import { getLanguageFromPath } from "../core/utils.js";

const IGNORED_DIRS = new Set([".git", ".agent", "node_modules", "dist", "coverage", ".research", ".next", "__pycache__", ".venv"]);
const MAX_FILE_SIZE = 256_000; // Skip files larger than 256KB

// ─── Public API ──────────────────────────────────────────────────────────────

export async function buildRepoMap(cwd: string, options?: {
  activeFiles?: string[];
  maxEntries?: number;
  includeRanking?: boolean;
}): Promise<RepoMapEntry[]> {
  const activeFiles = options?.activeFiles ?? [];
  const maxEntries = options?.maxEntries ?? 200;

  // Phase 1: Walk and extract symbols
  const fileData = new Map<string, FileSymbolData>();
  await walkAndExtract(cwd, cwd, fileData);

  if (fileData.size === 0) return [];

  // Phase 2: Build symbol graph
  const { defines, references } = buildSymbolGraph(fileData);

  // Phase 3: Build adjacency matrix and run PageRank
  const files = Array.from(fileData.keys());
  const adjacency = buildAdjacency(files, defines, references);
  const personalization = buildPersonalization(files, activeFiles);
  const ranks = pageRank(adjacency, personalization, files.length);

  // Phase 4: Sort by rank and return top entries
  const rankedFiles = files
    .map((f, i) => ({ path: f, rank: ranks[i], data: fileData.get(f)! }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxEntries);

  return rankedFiles.map(({ path: p, rank, data }) => ({
    path: p,
    kind: "file" as const,
    language: data.language,
    symbols: data.definitions.slice(0, 25),
    lineCount: data.lineCount,
    rank: options?.includeRanking ? rank : undefined
  }));
}

// ─── Symbol Extraction ───────────────────────────────────────────────────────

interface FileSymbolData {
  language: string;
  lineCount: number;
  definitions: string[];
  references: string[];
}

// Language-specific definition patterns
const DEFINITION_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /\b(?:export\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\b(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  ],
  python: [
    /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ],
  rust: [
    /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\b(?:pub\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ],
  go: [
    /\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/g,
    /\btype\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ],
  default: [
    /\b(?:function|class|interface|type|const|let|var|def|fn|struct|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  ]
};

// Identifier extraction for references
const IDENTIFIER_RE = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;

function getDefinitionPatterns(language: string): RegExp[] {
  if (language === "javascript" || language === "jsx" || language === "tsx") {
    return DEFINITION_PATTERNS.typescript;
  }
  return DEFINITION_PATTERNS[language] ?? DEFINITION_PATTERNS.default;
}

function extractDefinitions(content: string, language: string): string[] {
  const symbols = new Set<string>();
  const patterns = getDefinitionPatterns(language);
  for (const pattern of patterns) {
    // Reset lastIndex for global regexes
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(re)) {
      if (match[1] && match[1].length >= 2) {
        symbols.add(match[1]);
      }
    }
  }
  return Array.from(symbols);
}

function extractReferences(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(IDENTIFIER_RE)) {
    if (match[1].length >= 3) { // Skip very short identifiers
      refs.add(match[1]);
    }
  }
  return Array.from(refs);
}

// ─── File Walking ────────────────────────────────────────────────────────────

async function walkAndExtract(
  root: string,
  current: string,
  fileData: Map<string, FileSymbolData>
): Promise<void> {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of dirEntries) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath);

    if (entry.isDirectory()) {
      await walkAndExtract(root, fullPath, fileData);
      continue;
    }

    // Skip non-source files and large files
    const language = getLanguageFromPath(entry.name);
    if (language === "unknown" || language === "binary") continue;

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE) continue;

    let content;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const definitions = extractDefinitions(content, language);
    const references = extractReferences(content);
    const lineCount = content.split("\n").length;

    fileData.set(relativePath, { language, lineCount, definitions, references });
  }
}

// ─── Symbol Graph ────────────────────────────────────────────────────────────

function buildSymbolGraph(fileData: Map<string, FileSymbolData>): {
  defines: Map<string, Set<string>>; // symbol → set of files that define it
  references: Map<string, Set<string>>; // symbol → set of files that reference it
} {
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, Set<string>>();

  for (const [filePath, data] of fileData) {
    for (const sym of data.definitions) {
      if (!defines.has(sym)) defines.set(sym, new Set());
      defines.get(sym)!.add(filePath);
    }
    for (const sym of data.references) {
      if (!references.has(sym)) references.set(sym, new Set());
      references.get(sym)!.add(filePath);
    }
  }

  return { defines, references };
}

// ─── Adjacency Matrix ────────────────────────────────────────────────────────

function buildAdjacency(
  files: string[],
  defines: Map<string, Set<string>>,
  references: Map<string, Set<string>>
): number[][] {
  const n = files.length;
  const fileIndex = new Map<string, number>();
  files.forEach((f, i) => fileIndex.set(f, i));

  // Initialize adjacency matrix
  const adj: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const [symbol, defFiles] of defines) {
    const refFiles = references.get(symbol);
    if (!refFiles) continue;

    // Weight multipliers (aider-inspired)
    let weight = 1;

    // Meaningful identifiers (>= 8 chars, camelCase/snake_case) get 10x
    if (symbol.length >= 8 && (/[a-z][A-Z]/.test(symbol) || symbol.includes("_"))) {
      weight = 10;
    }

    // Private symbols (starts with _) get 0.1x
    if (symbol.startsWith("_")) {
      weight = 0.1;
    }

    // Symbols defined in many files (too common) get 0.1x
    if (defFiles.size > 5) {
      weight *= 0.1;
    }

    // Create edges: for each file that references this symbol,
    // add an edge to the file that defines it
    for (const refFile of refFiles) {
      const refIdx = fileIndex.get(refFile);
      if (refIdx === undefined) continue;

      for (const defFile of defFiles) {
        if (defFile === refFile) continue; // Skip self-references
        const defIdx = fileIndex.get(defFile);
        if (defIdx === undefined) continue;

        adj[refIdx][defIdx] += weight;
      }
    }
  }

  return adj;
}

// ─── Personalization ─────────────────────────────────────────────────────────

function buildPersonalization(files: string[], activeFiles: string[]): number[] {
  const n = files.length;
  const p = new Array(n).fill(1 / n); // Uniform baseline

  if (activeFiles.length === 0) return p;

  const activeSet = new Set(activeFiles.map((f) => f.replace(/\\/g, "/")));

  for (let i = 0; i < n; i++) {
    const normalized = files[i].replace(/\\/g, "/");
    if (activeSet.has(normalized)) {
      p[i] = 100 / activeFiles.length; // Strong bias toward active files (aider: 100/num_files)
    }
  }

  // Normalize
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (let i = 0; i < n; i++) p[i] /= sum;
  }

  return p;
}

// ─── PageRank ────────────────────────────────────────────────────────────────

function pageRank(
  adjacency: number[][],
  personalization: number[],
  n: number,
  damping = 0.85,
  maxIterations = 50,
  tolerance = 1e-6
): number[] {
  // Normalize adjacency rows to create transition matrix
  const transition: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const rowSum = adjacency[i].reduce((a, b) => a + b, 0);
    if (rowSum > 0) {
      for (let j = 0; j < n; j++) {
        transition[i][j] = adjacency[i][j] / rowSum;
      }
    }
  }

  // Initialize ranks uniformly
  let ranks = new Array(n).fill(1 / n);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newRanks = new Array(n).fill(0);

    // Compute dangling node contribution
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      const rowSum = adjacency[i].reduce((a, b) => a + b, 0);
      if (rowSum === 0) {
        danglingSum += ranks[i];
      }
    }

    for (let j = 0; j < n; j++) {
      // Incoming link contributions
      let linkContrib = 0;
      for (let i = 0; i < n; i++) {
        linkContrib += ranks[i] * transition[i][j];
      }

      // PageRank formula with personalization
      newRanks[j] =
        (1 - damping) * personalization[j] +
        damping * (linkContrib + danglingSum * personalization[j]);
    }

    // Normalize
    const sum = newRanks.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < n; i++) newRanks[i] /= sum;
    }

    // Check convergence
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(newRanks[i] - ranks[i]);
    }

    ranks = newRanks;
    if (diff < tolerance) break;
  }

  return ranks;
}

// ─── Backward Compatibility ──────────────────────────────────────────────────

/**
 * Simple flat repo map for backward compatibility.
 * Used when PageRank is not needed (e.g., small repos).
 */
export async function buildFlatRepoMap(cwd: string): Promise<RepoMapEntry[]> {
  const entries: RepoMapEntry[] = [];
  await walkFlat(cwd, cwd, entries);
  return entries;
}

async function walkFlat(root: string, current: string, entries: RepoMapEntry[]): Promise<void> {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of dirEntries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath) || ".";
    if (entry.isDirectory()) {
      entries.push({ path: relativePath, kind: "directory", language: "directory", symbols: [], lineCount: 0 });
      await walkFlat(root, fullPath, entries);
      continue;
    }
    const content = await fs.readFile(fullPath, "utf8").catch(() => "");
    entries.push({
      path: relativePath,
      kind: "file",
      language: getLanguageFromPath(entry.name),
      symbols: extractDefinitions(content, getLanguageFromPath(entry.name)).slice(0, 25),
      lineCount: content ? content.split("\n").length : 0
    });
  }
}
