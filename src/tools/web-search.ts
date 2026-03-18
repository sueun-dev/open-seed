/**
 * Built-in web/docs search tool.
 *
 * Provides web search capability using available local tools.
 * Strategy:
 * 1. If `ddgr` (DuckDuckGo CLI) is available, use it
 * 2. If `curl` is available, use DuckDuckGo Lite HTML scraping
 * 3. Return a helpful error with install instructions
 *
 * This replaces the need for external MCP servers like Exa or Grep.app
 * for basic documentation and reference lookup.
 */

import { spawn } from "node:child_process";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  source: "ddgr" | "curl-ddg" | "unavailable";
  error?: string;
}

export async function webSearch(params: {
  query: string;
  maxResults?: number;
}): Promise<WebSearchResponse> {
  const maxResults = params.maxResults ?? 5;

  // Try ddgr first
  if (await isCommandAvailable("ddgr")) {
    return searchWithDdgr(params.query, maxResults);
  }

  // Fall back to curl + DuckDuckGo lite
  if (await isCommandAvailable("curl")) {
    return searchWithCurlDdg(params.query, maxResults);
  }

  return {
    query: params.query,
    results: [],
    source: "unavailable",
    error: "No search backend available. Install ddgr (brew install ddgr) for web search capability."
  };
}

async function searchWithDdgr(query: string, maxResults: number): Promise<WebSearchResponse> {
  try {
    const { stdout } = await runCommand("ddgr", [
      "--json",
      "--num",
      String(maxResults),
      "--noprompt",
      query
    ]);

    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return { query, results: [], source: "ddgr", error: "Unexpected ddgr output format" };
    }

    const results: WebSearchResult[] = parsed.slice(0, maxResults).map((entry: Record<string, unknown>) => ({
      title: String(entry.title ?? ""),
      url: String(entry.url ?? ""),
      snippet: String(entry.abstract ?? "")
    }));

    return { query, results, source: "ddgr" };
  } catch (error) {
    return {
      query,
      results: [],
      source: "ddgr",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function searchWithCurlDdg(query: string, maxResults: number): Promise<WebSearchResponse> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await runCommand("curl", [
      "-sL",
      "--max-time",
      "10",
      "-A",
      "Mozilla/5.0 (compatible; agent40/0.1)",
      `https://lite.duckduckgo.com/lite/?q=${encoded}`
    ]);

    const results = parseDdgLiteHtml(stdout, maxResults);
    return { query, results, source: "curl-ddg" };
  } catch (error) {
    return {
      query,
      results: [],
      source: "curl-ddg",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDdgLiteHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // DuckDuckGo Lite returns a simple HTML table with results
  // Each result has a link in a <a> tag with class "result-link" and a snippet in a <td> with class "result-snippet"
  const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  const snippetPattern = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/<[^>]*>/g, "").trim();
    if (url && title && url.startsWith("http")) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? ""
    });
  }

  return results;
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const { exitCode } = await runCommand("which", [command]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 15_000);

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
