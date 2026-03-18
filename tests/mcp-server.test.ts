import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

function sendMcpRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cli = path.join(__dirname, "..", "dist", "cli.js");
    const child = spawn("node", [cli, "mcp"], {
      cwd: path.join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Try to parse the first complete JSON line
      const lines = stdout.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          child.kill();
          resolve(parsed);
          return;
        } catch {
          // not complete yet
        }
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timeout"));
    }, 10_000);

    child.on("close", () => {
      clearTimeout(timeout);
      if (!stdout.trim()) {
        reject(new Error("No response from MCP server"));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Send the request
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

describe("MCP server", () => {
  it("responds to initialize", async () => {
    const response = await sendMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });

    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect(response).toHaveProperty("id", 1);
    expect(response).toHaveProperty("result");
    const result = response.result as Record<string, unknown>;
    expect(result).toHaveProperty("serverInfo");
    const info = result.serverInfo as Record<string, unknown>;
    expect(info.name).toBe("agent40");
  });

  it("lists tools", async () => {
    const response = await sendMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });

    expect(response).toHaveProperty("result");
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThanOrEqual(6);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("agent40_search");
    expect(names).toContain("agent40_read");
    expect(names).toContain("agent40_repomap");
    expect(names).toContain("agent40_web_search");
    expect(names).toContain("agent40_ast_grep");
    expect(names).toContain("agent40_check_comments");
  });

  it("executes agent40_search tool", async () => {
    const response = await sendMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "agent40_search",
        arguments: { pattern: "export function", glob: "*.ts" }
      }
    });

    expect(response).toHaveProperty("result");
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("pattern", "export function");
    expect(data).toHaveProperty("matches");
    expect(data.matches.length).toBeGreaterThan(0);
  });

  it("executes agent40_check_comments tool", async () => {
    const response = await sendMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "agent40_check_comments",
        arguments: {}
      }
    });

    expect(response).toHaveProperty("result");
    const result = response.result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty("files");
    expect(data).toHaveProperty("findings");
    expect(data).toHaveProperty("summary");
  });

  it("returns error for unknown tool", async () => {
    const response = await sendMcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "nonexistent_tool",
        arguments: {}
      }
    });

    expect(response).toHaveProperty("error");
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32000);
    expect(error.message).toContain("Unknown tool");
  });
});
