import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types.js";
import { getConfigPath } from "./paths.js";
import { ensureDir, fileExists } from "./utils.js";

export function createDefaultConfig(): AgentConfig {
  return {
    providers: {
      anthropic: {
        enabled: true,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        authMode: "oauth",
        oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN",
        defaultModel: "set-me",
        timeoutMs: 15000,
        maxRetries: 2
      },
      openai: {
        enabled: true,
        apiKeyEnv: "OPENAI_API_KEY",
        authMode: "api_key",
        oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
        defaultModel: "set-me",
        timeoutMs: 15000,
        maxRetries: 2
      },
      gemini: {
        enabled: true,
        apiKeyEnv: "GEMINI_API_KEY",
        authMode: "api_key",
        oauthTokenEnv: "GEMINI_OAUTH_TOKEN",
        defaultModel: "set-me",
        timeoutMs: 15000,
        maxRetries: 2
      }
    },
    routing: {
      categories: {
        planning: "anthropic",
        research: "anthropic",
        execution: "openai",
        frontend: "gemini",
        review: "openai"
      }
    },
    safety: {
      defaultMode: "ask",
      autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run"],
      requireApproval: ["write", "edit", "bash_side_effect", "browser_submit", "git_push"]
    },
    roles: {
      active: ["orchestrator", "planner", "executor", "reviewer", "researcher"]
    },
    tools: {
      browser: true,
      lsp: true,
      hashEdit: true,
      repoMap: true,
      parallelReadMax: 4
    },
    team: {
      maxWorkers: 5,
      preferTmux: true
    },
    sessions: {
      localDirName: ".agent",
      globalNamespace: "agent40"
    },
    browser: {
      enabled: true,
      headless: true,
      doctorSmokeTest: false
    },
    lsp: {
      enabled: true
    },
    retry: {
      maxToolRetries: 3,
      maxParseRetries: 2,
      retriablePatterns: [
        "SyntaxError",
        "ENOENT",
        "ETIMEDOUT",
        "ECONNRESET",
        "rate_limit",
        "503",
        "429"
      ]
    },
    sandbox: {
      enabled: false,
      autoApplyOnPass: true
    },
    prompts: {},
    rules: []
  };
}

export async function loadConfig(cwd: string): Promise<AgentConfig> {
  const defaultConfig = createDefaultConfig();
  const configPath = getConfigPath(cwd, defaultConfig.sessions.localDirName);
  if (!(await fileExists(configPath))) {
    return defaultConfig;
  }
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<AgentConfig>;
  return {
    ...defaultConfig,
    ...parsed,
    providers: {
      ...defaultConfig.providers,
      ...parsed.providers
    },
    routing: {
      ...defaultConfig.routing,
      ...parsed.routing,
      categories: {
        ...defaultConfig.routing.categories,
        ...parsed.routing?.categories
      }
    },
    safety: {
      ...defaultConfig.safety,
      ...parsed.safety,
      autoApprove: parsed.safety?.autoApprove ?? defaultConfig.safety.autoApprove,
      requireApproval: parsed.safety?.requireApproval ?? defaultConfig.safety.requireApproval
    },
    team: {
      ...defaultConfig.team,
      ...parsed.team
    },
    sessions: {
      ...defaultConfig.sessions,
      ...parsed.sessions
    },
    browser: {
      ...defaultConfig.browser,
      ...parsed.browser
    },
    lsp: {
      ...defaultConfig.lsp,
      ...parsed.lsp
    },
    roles: {
      active: parsed.roles?.active ?? defaultConfig.roles.active
    },
    tools: {
      ...defaultConfig.tools,
      ...parsed.tools
    },
    retry: {
      ...defaultConfig.retry,
      ...parsed.retry
    },
    sandbox: {
      ...defaultConfig.sandbox,
      ...parsed.sandbox
    },
    prompts: {
      ...defaultConfig.prompts,
      ...parsed.prompts
    },
    rules: parsed.rules ?? defaultConfig.rules
  };
}

export async function writeDefaultConfig(cwd: string): Promise<string> {
  const config = createDefaultConfig();
  const configPath = getConfigPath(cwd, config.sessions.localDirName);
  await ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}
