import childProcess from "node:child_process";
import process from "node:process";

import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse, NativeToolCall } from "../core/types.js";
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

// No timeout limit — AGI pipeline can run for hours
const CLAUDE_CLI_MIN_TIMEOUT_MS = 0;

/** Convert our NativeToolDef[] to Anthropic's tools format */
function buildAnthropicTools(request: ProviderRequest): Array<Record<string, unknown>> | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

/** Parse Anthropic tool_use content blocks into NativeToolCall[] */
function parseAnthropicToolUse(content: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> | undefined): NativeToolCall[] {
  if (!content) return [];
  return content
    .filter(block => block.type === "tool_use" && block.name)
    .map(block => ({
      id: block.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: block.name!,
      arguments: block.input ?? {}
    }));
}

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

    const tools = buildAnthropicTools(request);
    const hasTools = tools !== undefined;

    if (options?.onTextDelta) {
      let text = "";
      let usage: ProviderResponse["usage"] | undefined;
      const collectedToolUse: Map<string, { id: string; name: string; jsonStr: string }> = new Map();
      let currentToolUseId = "";

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
          ],
          ...(hasTools ? { tools } : {})
        },
        fetchImpl: this.fetchImpl,
        async onMessage(message) {
          if (!message.data || message.data === "[DONE]") {
            return;
          }
          const json = JSON.parse(message.data) as {
            type?: string;
            index?: number;
            content_block?: { type?: string; id?: string; name?: string; text?: string };
            delta?: { type?: string; text?: string; partial_json?: string };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          // Text content
          if (message.event === "content_block_delta" && json.delta?.type === "text_delta" && json.delta.text) {
            text += json.delta.text;
            await options.onTextDelta?.(json.delta.text, "anthropic");
          }
          // Tool use content block start
          if (message.event === "content_block_start" && json.content_block?.type === "tool_use") {
            currentToolUseId = json.content_block.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`;
            collectedToolUse.set(currentToolUseId, {
              id: currentToolUseId,
              name: json.content_block.name ?? "",
              jsonStr: ""
            });
          }
          // Tool use input JSON delta
          if (message.event === "content_block_delta" && json.delta?.type === "input_json_delta" && json.delta.partial_json) {
            const existing = collectedToolUse.get(currentToolUseId);
            if (existing) {
              existing.jsonStr += json.delta.partial_json;
            }
          }
          if (json.usage) {
            usage = {
              inputTokens: json.usage.input_tokens,
              outputTokens: json.usage.output_tokens
            };
          }
        }
      });

      // Parse accumulated tool calls
      const nativeToolCalls: NativeToolCall[] = [];
      for (const [, tc] of collectedToolUse) {
        if (!tc.name) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.jsonStr || "{}"); } catch { /* malformed */ }
        nativeToolCalls.push({ id: tc.id, name: tc.name, arguments: args });
      }

      return {
        provider: "anthropic",
        model: request.model ?? config.defaultModel,
        text: normalizeProviderText(text, request),
        toolCalls: nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
        usage,
        metadata: {
          ...metadata,
          authMode: auth.authMode,
          warnings: auth.warnings
        }
      };
    }

    // Non-streaming path
    const { json, metadata } = await requestJsonWithRetry<{
      content?: Array<{ type?: string; id?: string; name?: string; text?: string; input?: Record<string, unknown> }>;
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
        ],
        ...(hasTools ? { tools } : {})
      },
      fetchImpl: this.fetchImpl
    });
    const textParts = json.content?.filter(part => part.type === "text").map(part => part.text ?? "") ?? [];
    const text = normalizeProviderText(textParts.join(""), request);
    const nativeToolCalls = parseAnthropicToolUse(json.content);

    return {
      provider: "anthropic",
      model: request.model ?? config.defaultModel,
      text,
      toolCalls: nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
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
  // Caller override takes precedence (e.g., AGI pipeline analysis step needs more output)
  if (request.maxTokens && request.maxTokens > 0) {
    return request.maxTokens;
  }
  // Environment override for AGI pipeline steps
  const envOverride = process.env.AGI_MAX_OUTPUT_TOKENS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
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

  return await new Promise((resolve, reject) => {
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
    const cliTimeoutMs = params.config.timeoutMs || 0;
    const timeout = cliTimeoutMs > 0
      ? setTimeout(() => { child.kill("SIGTERM"); }, cliTimeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout += text;
      streamed = streamed || stdout.length > text.length;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
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
