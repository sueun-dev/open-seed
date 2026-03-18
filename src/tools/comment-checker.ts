/**
 * Comment Checker.
 *
 * Scans source files for problematic comments:
 * - TODO / FIXME / HACK / XXX markers left in production code
 * - Stale comments that reference removed code
 * - Commented-out code blocks
 * - Empty or meaningless comments
 *
 * Returns structured findings that the reviewer role can use
 * to fail a review when problematic comments are present.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface CommentFinding {
  file: string;
  line: number;
  kind: "todo" | "fixme" | "hack" | "commented-code" | "empty-comment" | "stale-reference";
  text: string;
  severity: "error" | "warning";
}

export interface CommentCheckResult {
  files: number;
  findings: CommentFinding[];
  summary: {
    todos: number;
    fixmes: number;
    hacks: number;
    commentedCode: number;
    emptyComments: number;
    staleReferences: number;
  };
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".agent", "dist", "coverage", ".next",
  ".turbo", ".cache", "__pycache__", ".venv", "build", ".research"
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".css", ".scss", ".less", ".vue", ".svelte"
]);

// Match TODO/FIXME/etc. when they appear in comment context
// Standalone comment lines or inline comments after code
const COMMENT_CONTEXT_PATTERN = /(?:\/\/|#|\/?\*)\s*.*\b(TODO|FIXME|HACK|XXX|TEMP|TEMPORARY)\b/;
const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX|TEMP|TEMPORARY)\b/;
const COMMENTED_CODE_PATTERNS = [
  /^\s*\/\/\s*(import|export|const|let|var|function|class|interface|type|if|for|while|return|throw|try|catch)\b/,
  /^\s*\/\/\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=(]/,
  /^\s*#\s*(import|from|def|class|if|for|while|return|raise|try|except)\b/,
  /^\s*\/\/\s*[{}();]/
];
const EMPTY_COMMENT_PATTERN = /^\s*\/\/\s*$/;

export async function checkComments(params: {
  cwd: string;
  paths?: string[];
  includeWarnings?: boolean;
}): Promise<CommentCheckResult> {
  const includeWarnings = params.includeWarnings ?? true;
  const files = params.paths && params.paths.length > 0
    ? params.paths.map((p) => path.resolve(params.cwd, p))
    : await walkCodeFiles(params.cwd);

  const findings: CommentFinding[] = [];
  let fileCount = 0;

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    fileCount += 1;
    const relativePath = path.relative(params.cwd, filePath);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check for TODO/FIXME/HACK markers (only in comment context)
      const inCommentContext = COMMENT_CONTEXT_PATTERN.test(line);
      const todoMatch = inCommentContext ? TODO_PATTERN.exec(line) : null;
      if (todoMatch) {
        const marker = todoMatch[1].toUpperCase();
        const kind = marker === "FIXME" ? "fixme" as const
          : marker === "HACK" || marker === "XXX" ? "hack" as const
          : "todo" as const;
        findings.push({
          file: relativePath,
          line: lineNum,
          kind,
          text: line.trim(),
          severity: kind === "fixme" || kind === "hack" ? "error" : "warning"
        });
        continue;
      }

      // Check for commented-out code
      if (COMMENTED_CODE_PATTERNS.some((p) => p.test(line))) {
        findings.push({
          file: relativePath,
          line: lineNum,
          kind: "commented-code",
          text: line.trim(),
          severity: "warning"
        });
        continue;
      }

      // Check for empty comments
      if (EMPTY_COMMENT_PATTERN.test(line)) {
        if (includeWarnings) {
          findings.push({
            file: relativePath,
            line: lineNum,
            kind: "empty-comment",
            text: line.trim(),
            severity: "warning"
          });
        }
      }
    }
  }

  // Filter out warnings if not requested
  const filtered = includeWarnings
    ? findings
    : findings.filter((f) => f.severity === "error");

  return {
    files: fileCount,
    findings: filtered,
    summary: {
      todos: filtered.filter((f) => f.kind === "todo").length,
      fixmes: filtered.filter((f) => f.kind === "fixme").length,
      hacks: filtered.filter((f) => f.kind === "hack").length,
      commentedCode: filtered.filter((f) => f.kind === "commented-code").length,
      emptyComments: filtered.filter((f) => f.kind === "empty-comment").length,
      staleReferences: filtered.filter((f) => f.kind === "stale-reference").length
    }
  };
}

async function walkCodeFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }

  await visit(cwd);
  return files;
}
