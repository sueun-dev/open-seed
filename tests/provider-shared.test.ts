import { describe, expect, it, vi } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { ProviderRequest } from "../src/core/types.js";
import { normalizeProviderText, requestJsonWithRetry, requestSseWithRetry } from "../src/providers/shared.js";

const request: ProviderRequest = {
  role: "executor",
  category: "execution",
  systemPrompt: "Return JSON",
  prompt: "Do work",
  responseFormat: "json"
};

describe("provider shared helpers", () => {
  it("retries retryable HTTP responses and succeeds on a later attempt", async () => {
    const config = createDefaultConfig().providers.openai;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    const result = await requestJsonWithRetry<{ ok: boolean }>({
      config,
      url: "https://example.com",
      headers: { authorization: "Bearer test" },
      body: { ok: true },
      fetchImpl
    });

    expect(result.json.ok).toBe(true);
    expect(result.metadata.attempts).toBe(2);
  });

  it("normalizes balanced JSON out of mixed provider text", () => {
    const normalized = normalizeProviderText(
      'Here is the result:\n```json\n{"value":1,"nested":{"ok":true}}\n```\nextra text',
      request
    );
    expect(JSON.parse(normalized)).toEqual({
      value: 1,
      nested: { ok: true }
    });
  });

  it("throws when the provider does not return valid JSON", () => {
    expect(() => normalizeProviderText("not json", request)).toThrow(/invalid JSON/i);
  });

  it("parses SSE messages and forwards data blocks in order", async () => {
    const config = createDefaultConfig().providers.openai;
    const chunks = [
      "event: message\n",
      "data: {\"part\":\"he\"}\n\n",
      "event: message\n",
      "data: {\"part\":\"llo\"}\n\n"
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const seen: string[] = [];

    const result = await requestSseWithRetry({
      config,
      url: "https://example.com",
      headers: { authorization: "Bearer test" },
      body: { ok: true },
      fetchImpl,
      onMessage(message) {
        seen.push(`${message.event}:${message.data}`);
      }
    });

    expect(result.metadata.streamed).toBe(true);
    expect(seen).toEqual([
      "message:{\"part\":\"he\"}",
      "message:{\"part\":\"llo\"}"
    ]);
  });
});
