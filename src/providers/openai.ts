import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse, NativeToolCall } from "../core/types.js";
import { resolveProviderAuth, getProviderAuthStatus } from "./auth.js";
import { normalizeProviderText, requestJsonWithRetry, requestSseWithRetry } from "./shared.js";

/** Convert our NativeToolDef[] to OpenAI's tools format */
function buildOpenAITools(request: ProviderRequest): Record<string, unknown>[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

/** Parse OpenAI tool_calls from a message into our NativeToolCall[] */
function parseOpenAIToolCalls(toolCalls: Array<{
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}> | undefined): NativeToolCall[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls
    .filter(tc => tc.type === "function" && tc.function?.name)
    .map(tc => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function!.arguments ?? "{}"); } catch { /* malformed */ }
      return {
        id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function!.name!,
        arguments: args
      };
    });
}

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

    const tools = buildOpenAITools(request);
    const hasTools = tools !== undefined;

    // When tools are provided, don't force json response_format — the model
    // needs to be free to return tool_calls alongside or instead of text.
    const responseFormat = hasTools
      ? undefined
      : (request.responseFormat === "json" ? { type: "json_object" } : undefined);

    if (options?.onTextDelta) {
      let text = "";
      let usage: ProviderResponse["usage"] | undefined;
      const collectedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

      const { metadata } = await requestSseWithRetry<{
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
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
          response_format: responseFormat,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.prompt }
          ],
          ...(tools ? { tools } : {})
        },
        fetchImpl: this.fetchImpl,
        async onMessage(message) {
          if (!message.data || message.data === "[DONE]") return;
          try {
            const json = JSON.parse(message.data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) {
              text += delta.content;
              await options.onTextDelta?.(delta.content, "openai");
            }
            // Accumulate streamed tool_calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = collectedToolCalls.get(idx);
                if (tc.id) {
                  // New tool call starting
                  collectedToolCalls.set(idx, {
                    id: tc.id,
                    name: tc.function?.name ?? "",
                    args: tc.function?.arguments ?? ""
                  });
                } else if (existing) {
                  // Continuation of arguments
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                }
              }
            }
            if (json.usage) {
              usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
            }
          } catch { /* skip malformed SSE chunk */ }
        }
      });

      // Parse accumulated tool calls
      const nativeToolCalls: NativeToolCall[] = [];
      for (const [, tc] of collectedToolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.args || "{}"); } catch { /* malformed */ }
        nativeToolCalls.push({ id: tc.id, name: tc.name, arguments: args });
      }

      return {
        provider: "openai",
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
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
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
        response_format: responseFormat,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.prompt }
        ],
        ...(tools ? { tools } : {})
      },
      fetchImpl: this.fetchImpl
    });
    const text = normalizeProviderText(json.choices?.[0]?.message?.content ?? "", request);
    const nativeToolCalls = parseOpenAIToolCalls(json.choices?.[0]?.message?.tool_calls);

    return {
      provider: "openai",
      model: request.model ?? config.defaultModel,
      text,
      toolCalls: nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
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
    const collectedToolCalls: Map<string, { id: string; name: string; args: string }> = new Map();

    const { metadata } = await requestSseWithRetry<{
      type?: string;
      delta?: string;
      item_id?: string;
      output_index?: number;
      name?: string;
      arguments?: string;
      call_id?: string;
      response?: {
        output?: Array<{
          type?: string;
          id?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
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
            item_id?: string;
            name?: string;
            arguments?: string;
            call_id?: string;
            response?: {
              output?: Array<{
                type?: string;
                id?: string;
                call_id?: string;
                name?: string;
                arguments?: string;
              }>;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
          };
          if (json.type === "response.output_text.delta" && json.delta) {
            text += json.delta;
            await options?.onTextDelta?.(json.delta, "openai");
          }
          // Collect function call outputs from Responses API
          // Note: output_item.added has data in json.item, not top-level
          if (json.type === "response.function_call_arguments.delta" && json.item_id && json.delta) {
            const existing = collectedToolCalls.get(json.item_id);
            if (existing) {
              existing.args += json.delta;
            }
          }
          if (json.type === "response.output_item.added") {
            const item = (json as any).item;
            const itemId = item?.id ?? json.item_id;
            if (itemId && item?.type === "function_call") {
              collectedToolCalls.set(itemId, {
                id: item.call_id ?? itemId,
                name: item.name ?? "",
                args: ""
              });
            }
          }
          if (json.type === "response.completed") {
            usage = { inputTokens: json.response?.usage?.input_tokens, outputTokens: json.response?.usage?.output_tokens };
            // Also parse any tool calls from the completed response
            for (const item of json.response?.output ?? []) {
              if (item.type === "function_call" && item.name) {
                const key = item.id ?? item.call_id ?? item.name;
                if (!collectedToolCalls.has(key)) {
                  collectedToolCalls.set(key, {
                    id: item.call_id ?? item.id ?? key,
                    name: item.name,
                    args: item.arguments ?? "{}"
                  });
                }
              }
            }
          }
        } catch { /* skip malformed SSE chunk */ }
      }
    });

    // Parse accumulated tool calls
    const nativeToolCalls: NativeToolCall[] = [];
    for (const [, tc] of collectedToolCalls) {
      if (!tc.name) continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.args || "{}"); } catch { /* malformed */ }
      nativeToolCalls.push({ id: tc.id, name: tc.name, arguments: args });
    }

    return {
      provider: "openai",
      model,
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

  // Add tools if present (Responses API format)
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(t => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
    // When tools are present, remove json_object format constraint
    // so the model can freely return function calls
  } else if (request.responseFormat === "json") {
    // Only force JSON format when no tools
    body.text = { format: { type: "json_object" } };
  }

  return body;
}
