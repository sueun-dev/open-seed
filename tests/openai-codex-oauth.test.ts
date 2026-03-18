import { describe, expect, it, vi } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { ProviderRequest } from "../src/core/types.js";
import { OpenAIProviderAdapter } from "../src/providers/openai.js";

const request: ProviderRequest = {
  role: "executor",
  category: "execution",
  systemPrompt: "Return compact JSON only.",
  prompt: "Respond with {\"ok\":true}",
  responseFormat: "json"
};

describe("OpenAIProviderAdapter oauth mode", () => {
  it("uses Codex transport when oauth mode is enabled", async () => {
    const config = createDefaultConfig().providers.openai;
    config.defaultModel = "gpt-5.4";
    config.authMode = "oauth";
    delete process.env.OPENAI_OAUTH_TOKEN;

    const originalHome = process.env.HOME;
    const home = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const tempHome = await home.mkdtemp(path.join(os.tmpdir(), "agent40-oauth-home-"));
    await home.mkdir(path.join(tempHome, ".codex"), { recursive: true });
    await home.writeFile(path.join(tempHome, ".codex", "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "oauth-token",
        account_id: "acct-123"
      }
    }), "utf8");
    process.env.HOME = tempHome;

    const chunks = [
      "event: response.output_text.delta\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"ok\\\":\"}\n\n",
      "event: response.output_text.delta\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"true}\"}\n\n",
      "event: response.completed\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n\n"
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

    const adapter = new OpenAIProviderAdapter(fetchImpl);
    const result = await adapter.invoke(config, request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/codex/responses");
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(result.text).toBe("{\"ok\":true}");

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });
});
