/**
 * Built-in MCP (Model Context Protocol) server.
 *
 * Exposes agent40's tools as MCP-compatible endpoints that external
 * clients (Claude Code, other agents) can call.
 *
 * Protocol: JSON-RPC 2.0 over stdio (standard MCP transport).
 *
 * Exposed tools:
 * - agent40_search: grep + glob combined code search
 * - agent40_read: read file with optional hash anchors
 * - agent40_repomap: get repository structure map
 * - agent40_web_search: search the web for docs/references
 * - agent40_ast_grep: structural code search via ast-grep
 * - agent40_check_comments: scan for problematic comments
 * - agent40_run: execute a full agent40 task
 */

import { createInterface } from "node:readline";
import { buildRepoMap } from "../tools/repomap.js";
import { webSearch } from "../tools/web-search.js";
import { astGrepSearch } from "../tools/ast-grep.js";
import { checkComments } from "../tools/comment-checker.js";
import fs from "node:fs/promises";
import path from "node:path";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS: McpTool[] = [
  {
    name: "agent40_search",
    description: "Search code files by regex pattern and optional glob filter",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        glob: { type: "string", description: "Optional glob filter (e.g. *.ts)" },
        cwd: { type: "string", description: "Working directory (defaults to process.cwd())" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "agent40_read",
    description: "Read a file from the workspace",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to cwd" },
        cwd: { type: "string", description: "Working directory" }
      },
      required: ["path"]
    }
  },
  {
    name: "agent40_repomap",
    description: "Generate a repository structure map with files, languages, and symbols",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory" }
      }
    }
  },
  {
    name: "agent40_web_search",
    description: "Search the web for documentation and references",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", description: "Max results (default 5)" }
      },
      required: ["query"]
    }
  },
  {
    name: "agent40_ast_grep",
    description: "Structural code search using AST patterns",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST pattern (e.g. $FN($ARGS))" },
        language: { type: "string", description: "Language filter" },
        cwd: { type: "string", description: "Working directory" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "agent40_check_comments",
    description: "Scan source files for problematic comments (TODO, FIXME, HACK, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory" },
        errorsOnly: { type: "boolean", description: "Only return errors, not warnings" }
      }
    }
  }
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();

  switch (name) {
    case "agent40_search": {
      const pattern = String(args.pattern ?? "");
      const glob = typeof args.glob === "string" ? args.glob : undefined;
      const regex = new RegExp(pattern, "i");
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const files = await walkFiles(cwd);
      for (const file of files) {
        if (glob && !matchSimpleGlob(file, glob)) continue;
        let content: string;
        try { content = await fs.readFile(path.join(cwd, file), "utf8"); } catch { continue; }
        content.split("\n").forEach((line, i) => {
          if (regex.test(line)) {
            matches.push({ path: file, line: i + 1, text: line.trim() });
          }
        });
        if (matches.length >= 100) break;
      }
      return { pattern, matches };
    }

    case "agent40_read": {
      const filePath = path.resolve(cwd, String(args.path));
      const content = await fs.readFile(filePath, "utf8");
      return { path: path.relative(cwd, filePath), content };
    }

    case "agent40_repomap": {
      return buildRepoMap(cwd);
    }

    case "agent40_web_search": {
      return webSearch({
        query: String(args.query),
        maxResults: typeof args.maxResults === "number" ? args.maxResults : 5
      });
    }

    case "agent40_ast_grep": {
      return astGrepSearch({
        cwd,
        pattern: String(args.pattern),
        language: typeof args.language === "string" ? args.language : undefined
      });
    }

    case "agent40_check_comments": {
      return checkComments({
        cwd,
        includeWarnings: args.errorsOnly !== true
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function respond(id: number | string, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function respondError(id: number | string, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function runMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    let request: McpRequest;
    try {
      request = JSON.parse(line.trim());
    } catch {
      continue;
    }

    let response: McpResponse;

    try {
      switch (request.method) {
        case "initialize": {
          response = respond(request.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agent40", version: "0.1.0" }
          });
          break;
        }

        case "tools/list": {
          response = respond(request.id, { tools: TOOLS });
          break;
        }

        case "tools/call": {
          const params = request.params ?? {};
          const name = String(params.name ?? "");
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const result = await handleToolCall(name, args);
          response = respond(request.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          });
          break;
        }

        default: {
          response = respondError(request.id, -32601, `Method not found: ${request.method}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response = respondError(request.id, -32000, message);
    }

    process.stdout.write(JSON.stringify(response) + "\n");
  }
}

// Helpers
const SKIP = new Set([".git", "node_modules", ".agent", "dist", "coverage", ".research"]);

async function walkFiles(cwd: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await visit(path.join(dir, e.name));
      } else {
        result.push(path.relative(cwd, path.join(dir, e.name)));
      }
    }
  }
  await visit(cwd);
  return result;
}

function matchSimpleGlob(file: string, glob: string): boolean {
  const pattern = glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
  return new RegExp(pattern).test(file);
}
