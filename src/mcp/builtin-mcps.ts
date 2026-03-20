/**
 * Built-in MCP Server Configs — OMO's 3 remote MCPs.
 *
 * 1. websearch — Exa or Tavily web search
 * 2. context7 — Official documentation finder
 * 3. grep_app — GitHub code search
 *
 * These are configured as MCP server connections that the McpClient connects to.
 */

export interface BuiltinMcpConfig {
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Required env var for this MCP to work */
  requiredEnv?: string;
  /** Whether this MCP is enabled by default */
  enabledByDefault: boolean;
}

export const BUILTIN_MCPS: BuiltinMcpConfig[] = [
  {
    name: "websearch",
    description: "Web search via Exa or Tavily API — find docs, articles, code examples",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-web-search"],
    requiredEnv: "EXA_API_KEY",
    enabledByDefault: true
  },
  {
    name: "context7",
    description: "Official documentation finder — retrieves version-specific docs for any framework/library",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-context7"],
    enabledByDefault: true
  },
  {
    name: "grep_app",
    description: "GitHub code search — find open-source implementation examples",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-grep-app"],
    enabledByDefault: true
  },
  {
    name: "filesystem",
    description: "File system access with safety boundaries",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    enabledByDefault: false
  },
  {
    name: "github",
    description: "GitHub API — PRs, issues, repos, code search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requiredEnv: "GITHUB_TOKEN",
    enabledByDefault: false
  }
];

export function getEnabledMcps(disabledMcps: string[] = []): BuiltinMcpConfig[] {
  return BUILTIN_MCPS.filter(mcp =>
    mcp.enabledByDefault && !disabledMcps.includes(mcp.name)
  );
}

export function getMcpByName(name: string): BuiltinMcpConfig | undefined {
  return BUILTIN_MCPS.find(mcp => mcp.name === name);
}

export function getMcpEnvStatus(mcp: BuiltinMcpConfig): { ready: boolean; missing?: string } {
  if (!mcp.requiredEnv) return { ready: true };
  if (process.env[mcp.requiredEnv]) return { ready: true };
  return { ready: false, missing: mcp.requiredEnv };
}

export function listAllMcps(): Array<BuiltinMcpConfig & { envStatus: ReturnType<typeof getMcpEnvStatus> }> {
  return BUILTIN_MCPS.map(mcp => ({
    ...mcp,
    envStatus: getMcpEnvStatus(mcp)
  }));
}
