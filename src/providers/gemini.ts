import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse } from "../core/types.js";
import { getProviderAuthStatus, resolveProviderAuth } from "./auth.js";
import { normalizeProviderText, requestJsonWithRetry, requestSseWithRetry } from "./shared.js";

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly id = "gemini";

  constructor(private readonly fetchImpl?: typeof fetch) {}

  isConfigured(config: ProviderConfig | undefined): boolean {
    return getProviderAuthStatus("gemini", config).ready;
  }

  async invoke(config: ProviderConfig | undefined, request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    if (!config || !this.isConfigured(config)) {
      throw new Error("Gemini provider is not configured");
    }
    const auth = await resolveProviderAuth("gemini", config);
    const model = request.model ?? config.defaultModel;
    if (options?.onTextDelta) {
      let text = "";
      let usage: ProviderResponse["usage"] | undefined;
      const { metadata } = await requestSseWithRetry<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      }>({
        config,
        url: buildGeminiUrl(config.baseUrl, model, auth.token, true),
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json"
        },
        body: {
          systemInstruction: {
            parts: [{ text: request.systemPrompt }]
          },
          contents: [
            {
              parts: [{ text: request.prompt }]
            }
          ],
          generationConfig: request.responseFormat === "json"
            ? { responseMimeType: "application/json" }
            : undefined
        },
        fetchImpl: this.fetchImpl,
        async onMessage(message) {
          if (!message.data || message.data === "[DONE]") {
            return;
          }
          const json = JSON.parse(message.data) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          };
          const delta = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
          if (delta) {
            text += delta;
            await options.onTextDelta?.(delta, "gemini");
          }
          if (json.usageMetadata) {
            usage = {
              inputTokens: json.usageMetadata.promptTokenCount,
              outputTokens: json.usageMetadata.candidatesTokenCount
            };
          }
        }
      });
      return {
        provider: "gemini",
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
    const { json, metadata } = await requestJsonWithRetry<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>({
      config,
      url: buildGeminiUrl(config.baseUrl, model, auth.token, false),
      headers: {
        "content-type": "application/json"
      },
      body: {
        systemInstruction: {
          parts: [{ text: request.systemPrompt }]
        },
        contents: [
          {
            parts: [{ text: request.prompt }]
          }
        ],
        generationConfig: request.responseFormat === "json"
          ? { responseMimeType: "application/json" }
          : undefined
      },
      fetchImpl: this.fetchImpl
    });
    const text = normalizeProviderText(
      json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "",
      request
    );
    return {
      provider: "gemini",
      model,
      text,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount
      },
      metadata: {
        ...metadata,
        authMode: auth.authMode,
        warnings: auth.warnings
      }
    };
  }
}

function buildGeminiUrl(baseUrl: string | undefined, model: string, apiKey: string | undefined, streaming: boolean): string {
  const defaultBase = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${streaming ? "streamGenerateContent" : "generateContent"}`;
  const rawUrl = baseUrl
    ? streaming
      ? baseUrl.replace(":generateContent", ":streamGenerateContent")
      : baseUrl
    : defaultBase;
  const separator = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${separator}${streaming ? "alt=sse&" : ""}key=${apiKey}`;
}
