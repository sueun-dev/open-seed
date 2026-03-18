import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse } from "../src/core/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";

class StubProvider implements ProviderAdapter {
  constructor(
    readonly id: ProviderResponse["provider"],
    private readonly impl: (options?: ProviderInvokeOptions) => Promise<ProviderResponse>
  ) {}

  isConfigured(_config: ProviderConfig | undefined): boolean {
    return true;
  }

  invoke(_config: ProviderConfig | undefined, _request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    return this.impl(options);
  }
}

const request: ProviderRequest = {
  role: "planner",
  category: "planning",
  systemPrompt: "Return JSON",
  prompt: "Do work",
  responseFormat: "json"
};

describe("ProviderRegistry", () => {
  it("falls back to another configured provider when the preferred provider fails", async () => {
    const config = createDefaultConfig();
    const registry = new ProviderRegistry({
      openai: new StubProvider("openai", async () => {
        throw new Error("openai unavailable");
      }),
      anthropic: new StubProvider("anthropic", async () => ({
        provider: "anthropic",
        model: "anthropic-test",
        text: "{}"
      }))
    });

    const response = await registry.invokeWithFailover(config, "openai", request);

    expect(response.provider).toBe("anthropic");
    expect(response.metadata?.fallbackFrom).toBe("openai");
  });

  it("forwards streaming callbacks to the selected provider", async () => {
    const config = createDefaultConfig();
    const seen: string[] = [];
    const registry = new ProviderRegistry({
      openai: new StubProvider("openai", async (options) => {
        await options?.onTextDelta?.("hello", "openai");
        return {
          provider: "openai",
          model: "openai-test",
          text: "{\"ok\":true}",
          metadata: { streamed: true }
        };
      })
    });

    const response = await registry.invokeWithFailover(config, "openai", request, {
      onTextDelta(chunk, providerId) {
        seen.push(`${providerId}:${chunk}`);
      }
    });

    expect(response.provider).toBe("openai");
    expect(seen).toEqual(["openai:hello"]);
  });
});
