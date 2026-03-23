import type { ProviderConfig, ProviderId } from "../core/types.js";
import {
  isAnthropicClaudeAuthExpired,
  loadAnthropicClaudeCliAuth,
  loadOpenAICodexCliAuth,
  resolveAnthropicClaudeCliAuth
} from "./external-auth.js";

const ANTHROPIC_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14"
];

export interface ProviderAuthStatus {
  providerId: Exclude<ProviderId, "mock">;
  authMode: "api_key" | "oauth";
  credentialEnv: string;
  enabled: boolean;
  hasModel: boolean;
  hasCredential: boolean;
  credentialSource?: "env" | "external";
  supported: boolean;
  ready: boolean;
  summary: string;
  warnings: string[];
}

export interface ResolvedProviderAuth {
  providerId: Exclude<ProviderId, "mock">;
  authMode: "api_key" | "oauth";
  token: string;
  sourceEnv: string;
  sourceType: "env" | "external";
  sourcePath?: string;
  accountId?: string;
  refreshToken?: string;
  lastRefresh?: string;
  expiresAt?: number;
  baseUrl?: string;
  headers: Record<string, string>;
  warnings: string[];
}

export function getProviderAuthStatus(
  providerId: Exclude<ProviderId, "mock">,
  config: ProviderConfig | undefined
): ProviderAuthStatus {
  const authMode = config?.authMode ?? "api_key";
  const credentialEnv = authMode === "oauth"
    ? (config?.oauthTokenEnv ?? defaultOauthEnv(providerId))
    : (config?.apiKeyEnv ?? defaultApiKeyEnv(providerId));
  const enabled = Boolean(config?.enabled);
  const hasModel = Boolean(config?.defaultModel && config.defaultModel !== "set-me");
  const envCredential = credentialEnv ? process.env[credentialEnv] : undefined;
  const externalCredential = loadExternalOauthCredential(providerId, authMode);
  const hasCredential = Boolean(envCredential || externalCredential?.accessToken);
  const credentialSource = envCredential ? "env" : externalCredential ? "external" : undefined;
  const warnings = getWarnings(providerId, authMode, config);
  const supported = isSupported(providerId, authMode);
  const ready = enabled && hasModel && hasCredential && supported;

  let summary = `${authMode} via ${credentialSource === "external" ? externalCredential?.source : credentialEnv}`;
  if (!enabled) {
    summary = "disabled";
  } else if (!hasModel) {
    summary = "missing model";
  } else if (!supported) {
    summary = unsupportedSummary(providerId, authMode);
  } else if (!hasCredential) {
    summary = missingCredentialSummary(providerId, authMode, credentialEnv);
  } else if (warnings.length > 0) {
    summary = `${summary}; ${warnings[0]}`;
  }

  return {
    providerId,
    authMode,
    credentialEnv,
    enabled,
    hasModel,
    hasCredential,
    credentialSource,
    supported,
    ready,
    summary,
    warnings
  };
}

export async function resolveProviderAuth(
  providerId: Exclude<ProviderId, "mock">,
  config: ProviderConfig | undefined
): Promise<ResolvedProviderAuth> {
  if (!config) {
    throw new Error(`${providerId} provider config is missing`);
  }

  const status = getProviderAuthStatus(providerId, config);
  if (!status.ready) {
    throw new Error(status.summary);
  }

  const envToken = process.env[status.credentialEnv];
  const externalCredential = providerId === "anthropic" && status.authMode === "oauth"
    ? await resolveAnthropicClaudeCliAuth()
    : loadExternalOauthCredential(providerId, status.authMode);
  const token = envToken ?? externalCredential?.accessToken;
  if (!token) {
    throw new Error(`Missing credential env ${status.credentialEnv}`);
  }

  if (providerId === "openai") {
    const externalOpenAICodex = status.authMode === "oauth" && providerId === "openai"
      ? loadOpenAICodexCliAuth()
      : null;
    const accountId = externalOpenAICodex?.accountId;
    return {
      providerId,
      authMode: status.authMode,
      token,
      sourceEnv: status.credentialEnv,
      sourceType: envToken ? "env" : "external",
      sourcePath: envToken ? undefined : externalOpenAICodex?.source,
      accountId,
      refreshToken: externalOpenAICodex?.refreshToken,
      lastRefresh: externalOpenAICodex?.lastRefresh,
      baseUrl: status.authMode === "oauth"
        ? normalizeOpenAICodexBaseUrl(config.baseUrl)
        : (config.baseUrl ?? "https://api.openai.com/v1/chat/completions"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {})
      },
      warnings: status.warnings
    };
  }

  if (providerId === "anthropic") {
    const externalAnthropic = status.authMode === "oauth" && providerId === "anthropic"
      ? loadAnthropicClaudeCliAuth()
      : null;
    return {
      providerId,
      authMode: status.authMode,
      token,
      sourceEnv: status.credentialEnv,
      sourceType: envToken ? "env" : "external",
      sourcePath: envToken ? undefined : externalAnthropic?.source,
      refreshToken: externalAnthropic?.refreshToken,
      expiresAt: externalAnthropic?.expiresAt,
      headers: {
        "anthropic-version": "2023-06-01",
        ...(status.authMode === "oauth"
          ? { authorization: `Bearer ${token}` }
          : { "x-api-key": token }),
        ...(externalAnthropic?.organizationUuid ? { "x-organization-uuid": externalAnthropic.organizationUuid } : {}),
        ...(status.authMode === "oauth"
          ? { "anthropic-beta": ANTHROPIC_OAUTH_BETAS.join(",") }
          : {})
      },
      warnings: status.warnings
    };
  }

  return {
    providerId,
    authMode: status.authMode,
    token,
    sourceEnv: status.credentialEnv,
    sourceType: "env",
    headers: {},
    warnings: status.warnings
  };
}

function getWarnings(
  providerId: Exclude<ProviderId, "mock">,
  authMode: "api_key" | "oauth",
  config: ProviderConfig | undefined
): string[] {
  if (providerId === "openai" && authMode === "oauth") {
    const external = loadOpenAICodexCliAuth();
    const warnings = [];
    if (!external) {
      warnings.push("Codex CLI auth file was not found");
    }
    if (config?.baseUrl && isDirectOpenAIUrl(config.baseUrl)) {
      warnings.push("oauth mode will ignore api.openai.com and use chatgpt.com Codex transport instead");
    }
    return warnings;
  }
  if (providerId === "openai" && authMode === "api_key") {
    return ["OpenAI API key auth is disabled; use OPENAI_OAUTH_TOKEN or Codex CLI auth"];
  }
  if (providerId === "anthropic" && authMode === "oauth") {
    const external = loadAnthropicClaudeCliAuth();
    const warnings = [];
    if (!external) {
      warnings.push("Claude Code CLI auth not found — run 'claude' to authenticate");
    }
    if (external && isAnthropicClaudeAuthExpired(external)) {
      warnings.push("Claude Code OAuth token may be expired — run 'claude' to refresh");
    }
    return warnings;
  }
  return [];
}

function isSupported(providerId: Exclude<ProviderId, "mock">, authMode: "api_key" | "oauth"): boolean {
  if (providerId === "openai" && authMode === "api_key") {
    return false;
  }
  // Anthropic OAuth is supported via Claude Code CLI credentials
  if (providerId === "anthropic" && authMode === "oauth") {
    return true;
  }
  if (providerId === "gemini" && authMode === "oauth") {
    return false;
  }
  return true;
}

function unsupportedSummary(providerId: Exclude<ProviderId, "mock">, authMode: "api_key" | "oauth"): string {
  if (providerId === "openai" && authMode === "api_key") {
    return "OpenAI API key auth is disabled; use OAuth";
  }
  if (providerId === "anthropic" && authMode === "oauth") {
    return "Anthropic OAuth requires Claude Code CLI auth — run 'claude' to authenticate";
  }
  if (providerId === "gemini" && authMode === "oauth") {
    return "Gemini OAuth is not implemented yet";
  }
  return `${providerId} ${authMode} auth is not supported`;
}

function defaultApiKeyEnv(providerId: Exclude<ProviderId, "mock">): string {
  switch (providerId) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
  }
}

function defaultOauthEnv(providerId: Exclude<ProviderId, "mock">): string {
  switch (providerId) {
    case "anthropic":
      return "ANTHROPIC_OAUTH_TOKEN";
    case "openai":
      return "OPENAI_OAUTH_TOKEN";
    case "gemini":
      return "GEMINI_OAUTH_TOKEN";
  }
}

function loadExternalOauthCredential(
  providerId: Exclude<ProviderId, "mock">,
  authMode: "api_key" | "oauth"
): { accessToken: string; source: string } | null {
  if (authMode !== "oauth") {
    return null;
  }
  if (providerId === "openai") {
    return loadOpenAICodexCliAuth();
  }
  if (providerId === "anthropic") {
    return loadAnthropicClaudeCliAuth();
  }
  return null;
}

function missingCredentialSummary(
  providerId: Exclude<ProviderId, "mock">,
  authMode: "api_key" | "oauth",
  credentialEnv: string
): string {
  if (authMode !== "oauth") {
    return `missing ${credentialEnv}`;
  }
  if (providerId === "openai") {
    return `missing ${credentialEnv} or ~/.codex/auth.json`;
  }
  if (providerId === "anthropic") {
    return `missing ${credentialEnv} or Claude Code credentials`;
  }
  return `missing ${credentialEnv}`;
}

function isDirectOpenAIUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return url.includes("api.openai.com");
  }
}

function normalizeOpenAICodexBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed || isDirectOpenAIUrl(trimmed)) {
    return "https://chatgpt.com/backend-api/codex/responses";
  }
  return trimmed.endsWith("/codex/responses") ? trimmed : trimmed.replace(/\/$/, "");
}
