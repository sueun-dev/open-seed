import type { AgentConfig, ProviderAdapter, ProviderId, ProviderInvokeOptions, ProviderRequest, ProviderResponse, RoleDefinition } from "../core/types.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { MockProviderAdapter } from "./mock.js";
import { OpenAIProviderAdapter } from "./openai.js";
import { selectProviderForRole } from "../routing/policy.js";

export class ProviderRegistry {
  private readonly adapters: Record<ProviderId, ProviderAdapter>;

  constructor(adapters?: Partial<Record<ProviderId, ProviderAdapter>>) {
    this.adapters = {
      anthropic: new AnthropicProviderAdapter(),
      openai: new OpenAIProviderAdapter(),
      gemini: new GeminiProviderAdapter(),
      mock: new MockProviderAdapter(),
      ...adapters
    };
  }

  get(providerId: ProviderId): ProviderAdapter {
    return this.adapters[providerId];
  }

  resolveForRole(config: AgentConfig, role: RoleDefinition): { providerId: ProviderId; adapter: ProviderAdapter; usedMockFallback: boolean } {
    const providerId = selectProviderForRole(config, role);
    const adapter = this.get(providerId);
    const providerConfig = providerId === "mock" ? undefined : config.providers[providerId];
    if (adapter.isConfigured(providerConfig)) {
      return { providerId, adapter, usedMockFallback: false };
    }

    // Try other configured providers before giving up
    for (const fallbackId of (["anthropic", "openai", "gemini"] as const)) {
      if (fallbackId === providerId) continue;
      const fb = this.get(fallbackId);
      if (fb.isConfigured(config.providers[fallbackId])) {
        return { providerId: fallbackId, adapter: fb, usedMockFallback: false };
      }
    }

    // Never fall back to mock in production. Require real provider credentials.
    throw new Error(`No configured provider available for role ${role.id}. Preferred: ${providerId}. Configure at least one provider with valid credentials (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY).`);
  }

  async invokeWithFailover(
    config: AgentConfig,
    preferredProviderId: ProviderId,
    request: ProviderRequest,
    options?: ProviderInvokeOptions
  ): Promise<ProviderResponse> {
    const order = this.getInvocationOrder(config, preferredProviderId);
    const errors: string[] = [];

    for (const providerId of order) {
      const adapter = this.get(providerId);
      const providerConfig = providerId === "mock" ? undefined : config.providers[providerId];
      try {
        const response = await adapter.invoke(providerConfig, request, options);
        return {
          ...response,
          metadata: {
            ...response.metadata,
            fallbackFrom: providerId === preferredProviderId ? response.metadata?.fallbackFrom : preferredProviderId
          }
        };
      } catch (error) {
        errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`All provider fallbacks failed. ${errors.join(" | ")}`);
  }

  private getInvocationOrder(config: AgentConfig, preferredProviderId: ProviderId): ProviderId[] {
    const configuredProviders = (["anthropic", "openai", "gemini"] as const)
      .filter((providerId) => this.get(providerId).isConfigured(config.providers[providerId]));

    // If no real providers configured and tests explicitly passed mock, allow it
    if (configuredProviders.length === 0 && preferredProviderId === "mock") {
      return ["mock"];
    }

    const ordered: ProviderId[] = [
      preferredProviderId,
      ...configuredProviders.filter((providerId) => providerId !== preferredProviderId)
    ].filter(id => id !== "mock" || configuredProviders.length === 0);

    return Array.from(new Set(ordered));
  }
}
