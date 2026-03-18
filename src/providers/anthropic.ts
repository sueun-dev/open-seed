import childProcess from "node:child_process";
import process from "node:process";

import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse } from "../core/types.js";
import { getProviderAuthStatus, resolveProviderAuth } from "./auth.js";
import { normalizeProviderText, requestJsonWithRetry, requestSseWithRetry } from "./shared.js";

export interface ClaudeCliRunParams {
  config: ProviderConfig;
  request: ProviderRequest;
  model: string;
  onTextDelta?: ProviderInvokeOptions["onTextDelta"];
}

export type ClaudeCliRunner = (params: ClaudeCliRunParams) => Promise<{
  text: string;
  streamed: boolean;
  usage?: ProviderResponse["usage"];
}>;

const CLAUDE_CLI_MIN_TIMEOUT_MS = 120_000;

export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly id = "anthropic";

  constructor(
    private readonly fetchImpl?: typeof fetch,
    private readonly claudeCliRunner: ClaudeCliRunner = runClaudeCli
  ) {}

  isConfigured(config: ProviderConfig | undefined): boolean {
    return getProviderAuthStatus("anthropic", config).ready;
  }

  async invoke(config: ProviderConfig | undefined, request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    if (!config || !this.isConfigured(config)) {
      throw new Error("Anthropic provider is not configured");
    }
    const auth = await resolveProviderAuth("anthropic", config);
    if (auth.authMode === "oauth" && auth.sourceType === "external") {
      return this.invokeClaudeCliOauth(auth, config, request, options);
    }
    const url = auth.authMode === "oauth"
      ? normalizeAnthropicOauthUrl(config.baseUrl)
      : (config.baseUrl ?? "https://api.anthropic.com/v1/messages");
    if (options?.onTextDelta) {
      let text = "";
      let usage: ProviderResponse["usage"] | undefined;
      const { metadata } = await requestSseWithRetry({
        config,
        url,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...auth.headers
        },
        body: {
          model: request.model ?? config.defaultModel,
          max_tokens: resolveMaxTokens(request, config),
          stream: true,
          system: request.systemPrompt,
          messages: [
            {
              role: "user",
              content: request.prompt
            }
          ]
        },
        fetchImpl: this.fetchImpl,
        async onMessage(message) {
          if (!message.data || message.data === "[DONE]") {
            return;
          }
          const json = JSON.parse(message.data) as {
            delta?: { type?: string; text?: string };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (message.event === "content_block_delta" && json.delta?.type === "text_delta" && json.delta.text) {
            text += json.delta.text;
            await options.onTextDelta?.(json.delta.text, "anthropic");
          }
          if (json.usage) {
            usage = {
              inputTokens: json.usage.input_tokens,
              outputTokens: json.usage.output_tokens
            };
          }
        }
      });
      return {
        provider: "anthropic",
        model: request.model ?? config.defaultModel,
        text: normalizeProviderText(text, request),
        usage,
        metadata: {
          ...metadata,
          authMode: auth.authMode,
          warnings: auth.warnings
        }
      };
    }
    const { json, metadata } = await requestJsonWithRetry<{
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>({
      config,
      url,
      headers: {
        "content-type": "application/json",
        ...auth.headers
      },
      body: {
        model: request.model ?? config.defaultModel,
        max_tokens: resolveMaxTokens(request, config),
        system: request.systemPrompt,
        messages: [
          {
            role: "user",
            content: request.prompt
          }
        ]
      },
      fetchImpl: this.fetchImpl
    });
    const text = normalizeProviderText(json.content?.find((part) => part.type === "text")?.text ?? "", request);
    return {
      provider: "anthropic",
      model: request.model ?? config.defaultModel,
      text,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens
      },
      metadata: {
        ...metadata,
        authMode: auth.authMode,
        warnings: auth.warnings
      }
    };
  }

  private async invokeClaudeCliOauth(
    auth: Awaited<ReturnType<typeof resolveProviderAuth>>,
    config: ProviderConfig,
    request: ProviderRequest,
    options?: ProviderInvokeOptions
  ): Promise<ProviderResponse> {
    const model = request.model ?? config.defaultModel;
    const result = await this.claudeCliRunner({
      config,
      request,
      model,
      onTextDelta: options?.onTextDelta
    });
    return {
      provider: "anthropic",
      model,
      text: normalizeProviderText(result.text, request),
      usage: result.usage,
      metadata: {
        attempts: 1,
        streamed: result.streamed,
        authMode: auth.authMode,
        authSource: auth.sourceType,
        warnings: Array.from(new Set([
          ...auth.warnings,
          "Anthropic OAuth is using local Claude CLI transport"
        ]))
      }
    };
  }
}

const ROLE_MAX_TOKENS: Record<string, number> = {
  planner: 4096,
  researcher: 4096,
  orchestrator: 4096,
  executor: 8192,
  reviewer: 2048
};

const DEFAULT_MAX_TOKENS = 4096;

function resolveMaxTokens(request: ProviderRequest, config: ProviderConfig): number {
  // Use role-specific limit if known, otherwise default
  const roleTokens = ROLE_MAX_TOKENS[request.role] ?? DEFAULT_MAX_TOKENS;
  // Long prompts need more output room
  const promptLength = request.prompt.length + request.systemPrompt.length;
  if (promptLength > 8000) {
    return Math.max(roleTokens, 6144);
  }
  return roleTokens;
}

function normalizeAnthropicOauthUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim() || "https://api.anthropic.com/v1/messages";
  if (trimmed.includes("beta=true")) {
    return trimmed;
  }
  return trimmed.includes("?") ? `${trimmed}&beta=true` : `${trimmed}?beta=true`;
}

async function runClaudeCli(params: ClaudeCliRunParams): Promise<{
  text: string;
  streamed: boolean;
  usage?: ProviderResponse["usage"];
}> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    params.model,
    "--system-prompt",
    params.request.systemPrompt,
    "--tools",
    "",
    "--",
    params.request.prompt
  ];
  // Note: --json-schema causes Claude to output a schema definition instead of actual JSON.
  // The system prompt already instructs the model to return JSON, so no schema flag needed.

  return await new Promise((resolve, reject) => {
    // Remove CLAUDECODE to prevent nested session detection when agent40
    // spawns claude CLI from inside a Claude Code session.
    const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? "agent40" };
    delete childEnv.CLAUDECODE;

    const child = childProcess.spawn("claude", args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let streamed = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, Math.max(params.config.timeoutMs ?? 15_000, CLAUDE_CLI_MIN_TIMEOUT_MS));

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout += text;
      streamed = streamed || stdout.length > text.length;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Claude CLI exited with code ${code ?? "unknown"}`));
        return;
      }
      const parsed = parseClaudeCliPrintJson(stdout);
      const text = parsed?.result ?? stdout.trim();
      if (text.length > 0) {
        void params.onTextDelta?.(text, "anthropic");
      }
      resolve({
        text,
        streamed: streamed || text.length > 0,
        usage: parsed?.usage
      });
    });
  });
}

function parseClaudeCliPrintJson(raw: string): {
  result?: string;
  usage?: ProviderResponse["usage"];
} | null {
  try {
    const parsed = JSON.parse(raw) as {
      result?: string;
      structured_output?: {
        output?: unknown;
      };
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    const structuredOutput = parsed.structured_output?.output;
    return {
      result: typeof parsed.result === "string" && parsed.result.length > 0
        ? parsed.result
        : (structuredOutput !== undefined ? JSON.stringify(structuredOutput) : undefined),
      usage: parsed.usage ? {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens
      } : undefined
    };
  } catch {
    return null;
  }
}
