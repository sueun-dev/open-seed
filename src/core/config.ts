import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types.js";
import { getConfigPath } from "./paths.js";
import { ensureDir, fileExists } from "./utils.js";

/**
 * OMO-aligned defaults — batteries included, zero config.
 *
 * Philosophy: EVERYTHING is ON by default. Users disable what they don't need.
 * Matches oh-my-openagent's "install and forget" approach.
 *
 * - All 3 providers enabled (auto-detect credentials)
 * - All 40 roles active
 * - All tools enabled (browser, LSP, hashEdit, repoMap, AST grep, web search)
 * - Safety in auto mode (OMO auto-approves everything except git push)
 * - Sandbox enabled (Plandex-style safe writes)
 * - Self-healing, oracle escalation, verify-fix all active
 * - Session recovery, context monitoring, think mode all automatic
 * - Background agents with concurrency control
 */
export function createDefaultConfig(): AgentConfig {
  return {
    providers: {
      anthropic: {
        enabled: true,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        authMode: "oauth",
        oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN",
        defaultModel: "claude-opus-4-6",
        timeoutMs: 0,
        maxRetries: 3
      },
      openai: {
        enabled: true,
        apiKeyEnv: "OPENAI_API_KEY",
        authMode: "oauth",
        oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
        defaultModel: "gpt-5.4",
        timeoutMs: 0,
        maxRetries: 3
      },
      gemini: {
        enabled: true,
        apiKeyEnv: "GEMINI_API_KEY",
        authMode: "api_key",
        oauthTokenEnv: "GEMINI_OAUTH_TOKEN",
        defaultModel: "gemini-2.5-pro",
        timeoutMs: 0,
        maxRetries: 3
      }
    },
    routing: {
      categories: {
        planning: "anthropic",
        research: "anthropic",
        execution: "openai",
        frontend: "anthropic",
        review: "openai"
      }
    },
    safety: {
      // OMO style: auto-approve everything except dangerous actions
      defaultMode: "auto",
      autoApprove: [
        "read",
        "search",
        "lsp_diagnostics",
        "test_dry_run",
        "write",
        "edit",
        "bash_side_effect",
        "browser_submit"
      ],
      requireApproval: ["git_push"]
    },
    roles: {
      // ALL 40 roles active by default — OMO enables all agents
      active: [
        "orchestrator", "planner", "executor", "reviewer", "researcher",
        "repo-mapper", "search-specialist", "dependency-analyst",
        "security-auditor", "risk-analyst", "benchmark-analyst", "issue-triage-agent",
        "api-designer", "docs-writer", "prompt-engineer", "release-manager",
        "cost-optimizer", "model-router", "git-strategist", "pr-author",
        "lsp-analyst", "ast-rewriter", "build-doctor", "test-engineer",
        "debugger", "backend-engineer", "db-engineer", "performance-engineer",
        "devops-engineer", "cicd-engineer", "observability-engineer",
        "refactor-specialist", "code-simplifier", "migration-engineer", "toolsmith",
        "frontend-engineer", "ux-designer", "accessibility-auditor",
        "browser-operator", "compliance-reviewer"
      ]
    },
    tools: {
      // All tools ON — OMO registers all 26 tools by default
      browser: true,
      lsp: true,
      hashEdit: true,
      repoMap: true,
      parallelReadMax: 8
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
      doctorSmokeTest: true
    },
    lsp: {
      enabled: true
    },
    retry: {
      maxToolRetries: 5,
      maxParseRetries: 3,
      retriablePatterns: [
        "SyntaxError",
        "ENOENT",
        "ETIMEDOUT",
        "ECONNRESET",
        "rate_limit",
        "overloaded",
        "503",
        "429",
        "502",
        "500"
      ]
    },
    sandbox: {
      // OMO-style: sandbox ON for safe writes, auto-apply on pass
      enabled: true,
      autoApplyOnPass: true
    },
    tmux: {
      enabled: true,
      layout: "main-vertical",
      mainPaneSize: 60
    },
    disabled: {
      // OMO style: everything ON, disable explicitly
      hooks: [],
      agents: [],
      tools: [],
      skills: [],
      mcps: [],
      commands: []
    },
    experimental: {
      taskSystem: true,
      preemptiveCompaction: true,
      safeHookCreation: false,
      dynamicContextPruning: false
    },
    notification: {
      enabled: true,
      minDurationMs: 30000
    },
    websearchProvider: "exa",
    backgroundConcurrency: 5,
    prompts: {},
    rules: [
      // Built-in safety rules — OMO's tool guards
      {
        id: "block-env-writes",
        description: "Block writes to .env, .credentials, secrets files",
        filePatterns: [".env", ".env.*", "**/.env", "**/.env.*", "**/.credentials*", "**/secrets.*"],
        approvalOverride: "block",
        enabled: true
      },
      {
        id: "block-destructive-commands",
        description: "Block rm -rf, DROP TABLE, and other destructive commands",
        commandPatterns: ["rm -rf", "rm -fr", "DROP TABLE", "DROP DATABASE", "truncate table"],
        approvalOverride: "block",
        enabled: true
      },
      {
        id: "block-force-push",
        description: "Block git force push",
        commandPatterns: ["push --force", "push -f", "reset --hard origin"],
        approvalOverride: "block",
        enabled: true
      }
    ]
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
  const merged: AgentConfig = {
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

  // Environment variable overrides for model selection (from UI model picker)
  const envProvider = process.env.OPENSEED_PROVIDER;
  const envModel = process.env.OPENSEED_MODEL;
  if (envProvider && envModel) {
    const validProviders = ["openai", "anthropic", "gemini"] as const;
    if (validProviders.includes(envProvider as typeof validProviders[number])) {
      const p = envProvider as typeof validProviders[number];
      merged.routing.categories = {
        planning: p,
        research: p,
        execution: p,
        frontend: p,
        review: p
      };
      if (merged.providers[p]) {
        merged.providers[p].defaultModel = envModel;
      }
    }
  }

  return merged;
}

export async function writeDefaultConfig(cwd: string): Promise<string> {
  const config = createDefaultConfig();
  const configPath = getConfigPath(cwd, config.sessions.localDirName);
  await ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}
