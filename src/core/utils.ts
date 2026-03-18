import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".css": "css",
    ".html": "html",
    ".sh": "shell"
  };
  return map[ext] ?? "text";
}

export function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const balanced = extractBalancedJsonValue(raw);
  if (balanced) {
    return balanced;
  }
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start = [firstBrace, firstBracket].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  return start === undefined ? raw.trim() : raw.slice(start).trim();
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractBalancedJsonValue(raw: string): string | null {
  const starts = raw
    .split("")
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => character === "{" || character === "[");

  for (const { character, index } of starts) {
    const candidate = findBalancedJson(raw, index, character === "{" ? "}" : "]");
    if (candidate) {
      return candidate.trim();
    }
  }
  return null;
}

function findBalancedJson(raw: string, start: number, expectedClose: "}" | "]"): string | null {
  const stack: Array<"}" | "]"> = [expectedClose];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") {
      stack.push("}");
      continue;
    }
    if (character === "[") {
      stack.push("]");
      continue;
    }
    if (character === "}" || character === "]") {
      if (stack[stack.length - 1] !== character) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}
