import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse } from "../core/types.js";
import { resolveProviderAuth, getProviderAuthStatus } from "./auth.js";
import { normalizeProviderText, requestJsonWithRetry, requestSseWithRetry } from "./shared.js";

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly id = "openai";

  constructor(private readonly fetchImpl?: typeof fetch) {}

  isConfigured(config: ProviderConfig | undefined): boolean {
    return getProviderAuthStatus("openai", config).ready;
  }

  async invoke(config: ProviderConfig | undefined, request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    if (!config || !this.isConfigured(config)) {
      throw new Error("OpenAI provider is not configured");
    }
    const auth = await resolveProviderAuth("openai", config);
    if (auth.authMode === "oauth") {
      return this.invokeCodexOauth(auth, config, request, options);
    }
    if (options?.onTextDelta) {
      let text = "";
      let usage: ProviderResponse["usage"] | undefined;
      const { metadata } = await requestSseWithRetry<{
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>({
        config,
        url: config.baseUrl ?? "https://api.openai.com/v1/chat/completions",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...auth.headers
        },
        body: {
          model: request.model ?? config.defaultModel,
          temperature: 0.1,
          stream: true,
          stream_options: { include_usage: true },
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
          messages: [
            {
              role: "system",
              content: request.systemPrompt
            },
            {
              role: "user",
              content: request.prompt
            }
          ]
        },
        fetchImpl: this.fetchImpl,
        async onMessage(message) {
          if (!message.data || message.data === "[DONE]") return;
          try {
            const json = JSON.parse(message.data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = json.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              text += delta;
              await options.onTextDelta?.(delta, "openai");
            }
            if (json.usage) {
              usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
            }
          } catch { /* skip malformed SSE chunk */ }
        }
      });
      return {
        provider: "openai",
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
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>({
      config,
      url: config.baseUrl ?? "https://api.openai.com/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        ...auth.headers
      },
      body: {
        model: request.model ?? config.defaultModel,
        temperature: 0.1,
        response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
        messages: [
          {
            role: "system",
            content: request.systemPrompt
          },
          {
            role: "user",
            content: request.prompt
          }
        ]
      },
      fetchImpl: this.fetchImpl
    });
    const text = normalizeProviderText(json.choices?.[0]?.message?.content ?? "", request);
    return {
      provider: "openai",
      model: request.model ?? config.defaultModel,
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens
      },
      metadata: {
        ...metadata,
        authMode: auth.authMode,
        warnings: auth.warnings
      }
    };
  }

  private async invokeCodexOauth(
    auth: Awaited<ReturnType<typeof resolveProviderAuth>>,
    config: ProviderConfig,
    request: ProviderRequest,
    options?: ProviderInvokeOptions
  ): Promise<ProviderResponse> {
    const model = request.model ?? config.defaultModel;
    const url = auth.baseUrl ?? "https://chatgpt.com/backend-api/codex/responses";
    let text = "";
    let usage: ProviderResponse["usage"] | undefined;
    const { metadata } = await requestSseWithRetry<{
      type?: string;
      delta?: string;
      response?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
      };
    }>({
      config,
      url,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...auth.headers
      },
      body: buildCodexResponseBody(model, request, true),
      fetchImpl: this.fetchImpl,
      async onMessage(message) {
        if (!message.data || message.data === "[DONE]") return;
        try {
          const json = JSON.parse(message.data) as {
            type?: string;
            delta?: string;
            response?: { usage?: { input_tokens?: number; output_tokens?: number } };
          };
          if (json.type === "response.output_text.delta" && json.delta) {
            text += json.delta;
            await options?.onTextDelta?.(json.delta, "openai");
          }
          if (json.type === "response.completed") {
            usage = { inputTokens: json.response?.usage?.input_tokens, outputTokens: json.response?.usage?.output_tokens };
          }
        } catch { /* skip malformed SSE chunk */ }
      }
    });
    return {
      provider: "openai",
      model,
      text: normalizeProviderText(text, request),
      usage,
      metadata: {
        ...metadata,
        authMode: auth.authMode,
        warnings: auth.warnings
      }
    };
  }
}

function buildCodexResponseBody(model: string, request: ProviderRequest, stream: boolean): Record<string, unknown> {
  // Codex Responses API has a very limited `instructions` field.
  // Merge system prompt INTO the user message to ensure the model sees everything.
  const fullPrompt = `${request.systemPrompt}\n\n---\n\n${request.prompt}`;

  const input = [{
    role: "user",
    content: [
      {
        type: "input_text",
        text: fullPrompt
      }
    ]
  }];

  const body: Record<string, unknown> = {
    model,
    stream,
    store: false,
    instructions: "You are an expert coding agent. Follow ALL instructions in the user message. Respond with valid JSON only.",
    input
  };

  // Force JSON output format for Codex Responses API
  if (request.responseFormat === "json") {
    body.text = { format: { type: "json_object" } };
  }

  return body;
}
