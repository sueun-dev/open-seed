import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ANTHROPIC_DEFAULT_OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers"
];

export interface ExternalOpenAICodexAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  authMode?: string;
  lastRefresh?: string;
  source: string;
}

export interface ExternalAnthropicClaudeAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  organizationUuid?: string;
  source: string;
}

export function loadOpenAICodexCliAuth(): ExternalOpenAICodexAuth | null {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as {
      auth_mode?: string;
      last_refresh?: string;
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
    };
    const accessToken = parsed.tokens?.access_token?.trim();
    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken: parsed.tokens?.refresh_token?.trim() || undefined,
      accountId: parsed.tokens?.account_id?.trim() || undefined,
      authMode: parsed.auth_mode?.trim() || undefined,
      lastRefresh: parsed.last_refresh?.trim() || undefined,
      source: authPath
    };
  } catch {
    return null;
  }
}

export function loadAnthropicClaudeCliAuth(): ExternalAnthropicClaudeAuth | null {
  const plaintext = loadAnthropicClaudePlaintextAuth();
  if (plaintext) {
    return plaintext;
  }

  return loadAnthropicClaudeKeychainAuth();
}

export async function resolveAnthropicClaudeCliAuth(): Promise<ExternalAnthropicClaudeAuth | null> {
  const auth = loadAnthropicClaudeCliAuth();
  if (!auth) {
    return null;
  }
  if (!isAnthropicClaudeAuthExpired(auth)) {
    return auth;
  }
  return refreshAnthropicClaudeCliAuth(auth);
}

export function isAnthropicClaudeAuthExpired(
  auth: ExternalAnthropicClaudeAuth,
  skewMs = 60_000
): boolean {
  return typeof auth.expiresAt === "number" && auth.expiresAt <= Date.now() + skewMs;
}

export async function refreshAnthropicClaudeCliAuth(
  auth: ExternalAnthropicClaudeAuth
): Promise<ExternalAnthropicClaudeAuth> {
  if (!auth.refreshToken) {
    return auth;
  }

  const clientId = loadAnthropicClaudeOauthClientId();
  if (!clientId) {
    return auth;
  }

  try {
    const response = await fetch(getAnthropicClaudeTokenUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: clientId,
        scope: (auth.scopes?.length ? auth.scopes : ANTHROPIC_DEFAULT_OAUTH_SCOPES).join(" ")
      })
    });
    if (!response.ok) {
      return auth;
    }

    const json = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const accessToken = json.access_token?.trim();
    if (!accessToken) {
      return auth;
    }

    return {
      ...auth,
      accessToken,
      refreshToken: json.refresh_token?.trim() || auth.refreshToken,
      expiresAt: typeof json.expires_in === "number" ? Date.now() + (json.expires_in * 1000) : auth.expiresAt,
      scopes: typeof json.scope === "string"
        ? parseAnthropicScopeString(json.scope)
        : auth.scopes
    };
  } catch {
    return auth;
  }
}

function loadAnthropicClaudePlaintextAuth(): ExternalAnthropicClaudeAuth | null {
  const authPath = path.join(getClaudeConfigDir(), ".credentials.json");
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(authPath, "utf8");
    return parseAnthropicClaudeAuth(raw, authPath);
  } catch {
    return null;
  }
}

function loadAnthropicClaudeKeychainAuth(): ExternalAnthropicClaudeAuth | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const accountName = process.env.USER?.trim() || os.userInfo().username;
  const serviceName = getClaudeKeychainServiceName("-credentials");
  try {
    const result = childProcess.spawnSync("security", [
      "find-generic-password",
      "-a",
      accountName,
      "-w",
      "-s",
      serviceName
    ], {
      encoding: "utf8"
    });
    if (result.status !== 0 || !result.stdout?.trim()) {
      return null;
    }
    return parseAnthropicClaudeAuth(result.stdout.trim(), `keychain:${serviceName}`);
  } catch {
    return null;
  }
}

function parseAnthropicClaudeAuth(raw: string, source: string): ExternalAnthropicClaudeAuth | null {
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        scopes?: string[];
        subscriptionType?: string;
        rateLimitTier?: string;
      };
      organizationUuid?: string;
    };
    const accessToken = parsed.claudeAiOauth?.accessToken?.trim();
    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken: parsed.claudeAiOauth?.refreshToken?.trim() || undefined,
      expiresAt: typeof parsed.claudeAiOauth?.expiresAt === "number"
        ? parsed.claudeAiOauth.expiresAt
        : undefined,
      scopes: Array.isArray(parsed.claudeAiOauth?.scopes)
        ? parsed.claudeAiOauth.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
        : undefined,
      subscriptionType: parsed.claudeAiOauth?.subscriptionType?.trim() || undefined,
      rateLimitTier: parsed.claudeAiOauth?.rateLimitTier?.trim() || undefined,
      organizationUuid: parsed.organizationUuid?.trim() || undefined,
      source
    };
  } catch {
    return null;
  }
}

function getClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return configured;
  }
  return path.join(os.homedir(), ".claude");
}

function getClaudeKeychainServiceName(suffix: string): string {
  const customOauthSuffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.trim()
    ? "-custom-oauth"
    : "";
  const configHash = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? `-${crypto.createHash("sha256").update(getClaudeConfigDir()).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code${customOauthSuffix}${suffix}${configHash}`;
}

function getAnthropicClaudeTokenUrl(): string {
  const customBaseUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.trim();
  if (!customBaseUrl) {
    return "https://platform.claude.com/v1/oauth/token";
  }
  return `${customBaseUrl.replace(/\/$/, "")}/v1/oauth/token`;
}

function loadAnthropicClaudeOauthClientId(): string | null {
  const explicit = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim();
  if (explicit) {
    return explicit;
  }

  const bundledCliPath = path.join(
    os.homedir(),
    ".claude",
    "local",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js"
  );
  if (!fs.existsSync(bundledCliPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(bundledCliPath, "utf8");
    const match = raw.match(/CLIENT_ID:\"([^\"]+)\"/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function parseAnthropicScopeString(scope: string): string[] {
  return scope
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
