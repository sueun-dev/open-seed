/**
 * MCP Client — consume external MCP servers.
 *
 * Connects to external MCP servers (Claude Code, custom tools, etc.)
 * via JSON-RPC 2.0 over stdio or HTTP and makes their tools available
 * to agent40's tool runtime.
 *
 * Inspired by: Cline's MCP integration, Claude Code's MCP client.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { ToolDefinition, ToolName, ToolCall, ToolResult, ApprovalDecision } from "../core/types.js";

export interface McpServerConfig {
  /** Unique server name */
  name: string;
  /** Command to start the server */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Connection timeout in ms */
  timeoutMs?: number;
}

export interface McpClientTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private tools: McpClientTool[] = [];

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to connect to MCP server: ${this.config.name}`);
    }

    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => {
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    this.process.on("error", (err) => {
      for (const pending of this.pending.values()) {
        pending.reject(err);
      }
      this.pending.clear();
    });

    // Initialize
    const initResponse = await this.request("initialize", {});
    if (!initResponse.result) {
      throw new Error(`MCP server ${this.config.name} failed to initialize`);
    }

    // List tools
    const toolsResponse = await this.request("tools/list", {});
    const result = toolsResponse.result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } | undefined;
    this.tools = (result?.tools ?? []).map((t) => ({
      ...t,
      serverName: this.config.name
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) {
      throw new Error(`MCP tool ${name} failed: ${response.error.message}`);
    }
    return response.result;
  }

  getTools(): McpClientTool[] {
    return [...this.tools];
  }

  async disconnect(): Promise<void> {
    this.readline?.close();
    this.process?.kill();
    this.process = null;
    this.readline = null;
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeoutMs = this.config.timeoutMs ?? 30_000;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.process?.stdin?.write(JSON.stringify(request) + "\n");
    });
  }
}

/**
 * MCP Client Manager — manages connections to multiple MCP servers.
 */
export class McpClientManager {
  private clients = new Map<string, McpClient>();

  async connect(config: McpServerConfig): Promise<McpClient> {
    if (this.clients.has(config.name)) {
      return this.clients.get(config.name)!;
    }
    const client = new McpClient(config);
    await client.connect();
    this.clients.set(config.name, client);
    return client;
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  getAllTools(): McpClientTool[] {
    const tools: McpClientTool[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.getTools());
    }
    return tools;
  }

  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  listConnected(): string[] {
    return Array.from(this.clients.keys());
  }
}
