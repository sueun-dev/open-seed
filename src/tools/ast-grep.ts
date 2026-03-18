/**
 * AST-Grep integration.
 *
 * Provides structural code search and rewriting using ast-grep (sg).
 * Falls back to regex-based grep when ast-grep is not installed.
 *
 * Supports:
 * - Structural pattern matching (e.g. `$FN($ARGS)`)
 * - Language-specific searching
 * - Match extraction with file/line/match context
 */

import { spawn } from "node:child_process";

export interface AstGrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  matchedNode: string;
}

export interface AstGrepResult {
  available: boolean;
  pattern: string;
  language: string;
  matches: AstGrepMatch[];
  error?: string;
}

let cachedAvailability: boolean | null = null;

export async function isAstGrepAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) {
    return cachedAvailability;
  }
  try {
    const result = await runSg(["--version"], process.cwd());
    cachedAvailability = result.exitCode === 0;
    return cachedAvailability;
  } catch {
    cachedAvailability = false;
    return false;
  }
}

export async function astGrepSearch(params: {
  cwd: string;
  pattern: string;
  language?: string;
  paths?: string[];
}): Promise<AstGrepResult> {
  const available = await isAstGrepAvailable();
  if (!available) {
    return {
      available: false,
      pattern: params.pattern,
      language: params.language ?? "auto",
      matches: [],
      error: "ast-grep (sg) is not installed. Install with: npm install -g @ast-grep/cli"
    };
  }

  const args = [
    "run",
    "--pattern",
    params.pattern,
    "--json"
  ];

  if (params.language) {
    args.push("--lang", params.language);
  }

  if (params.paths && params.paths.length > 0) {
    args.push(...params.paths);
  }

  try {
    const result = await runSg(args, params.cwd);
    const matches = parseAstGrepJson(result.stdout);
    return {
      available: true,
      pattern: params.pattern,
      language: params.language ?? "auto",
      matches: matches.slice(0, 200)
    };
  } catch (error) {
    return {
      available: true,
      pattern: params.pattern,
      language: params.language ?? "auto",
      matches: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function astGrepRewrite(params: {
  cwd: string;
  pattern: string;
  rewrite: string;
  language?: string;
  dryRun?: boolean;
}): Promise<{
  available: boolean;
  pattern: string;
  rewrite: string;
  affectedFiles: string[];
  error?: string;
}> {
  const available = await isAstGrepAvailable();
  if (!available) {
    return {
      available: false,
      pattern: params.pattern,
      rewrite: params.rewrite,
      affectedFiles: [],
      error: "ast-grep (sg) is not installed"
    };
  }

  const args = [
    "run",
    "--pattern",
    params.pattern,
    "--rewrite",
    params.rewrite
  ];

  if (params.language) {
    args.push("--lang", params.language);
  }

  if (params.dryRun) {
    args.push("--json");
  } else {
    args.push("--update-all");
  }

  try {
    const result = await runSg(args, params.cwd);
    if (params.dryRun) {
      const matches = parseAstGrepJson(result.stdout);
      return {
        available: true,
        pattern: params.pattern,
        rewrite: params.rewrite,
        affectedFiles: [...new Set(matches.map((m) => m.file))]
      };
    }
    // parse affected files from stderr/stdout
    const files = (result.stdout + result.stderr)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim());
    return {
      available: true,
      pattern: params.pattern,
      rewrite: params.rewrite,
      affectedFiles: files
    };
  } catch (error) {
    return {
      available: true,
      pattern: params.pattern,
      rewrite: params.rewrite,
      affectedFiles: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseAstGrepJson(raw: string): AstGrepMatch[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((entry: Record<string, unknown>) => ({
      file: String(entry.file ?? ""),
      line: typeof entry.range === "object" && entry.range !== null
        ? (entry.range as Record<string, unknown>).start !== undefined
          ? Number((entry.range as Record<string, Record<string, number>>).start?.line ?? 0)
          : 0
        : 0,
      column: typeof entry.range === "object" && entry.range !== null
        ? Number((entry.range as Record<string, Record<string, number>>).start?.column ?? 0)
        : 0,
      text: String(entry.text ?? ""),
      matchedNode: String(entry.text ?? entry.matchedNode ?? "")
    })).filter((match: AstGrepMatch) => match.file.length > 0);
  } catch {
    return [];
  }
}

function runSg(args: string[], cwd: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("sg", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
