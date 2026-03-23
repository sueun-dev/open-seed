import type { AgentConfig, ProviderAdapter, ProviderId, ProviderInvokeOptions, ProviderRequest, ProviderResponse, RoleDefinition } from "../core/types.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { MockProviderAdapter } from "./mock.js";
import { OpenAIProviderAdapter } from "./openai.js";
import { getPinnedProvider, selectProviderForRole } from "../routing/policy.js";

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
    if (this.isProviderUsable(config, providerId)) {
      return { providerId, adapter, usedMockFallback: false };
    }

    const pinnedProvider = getPinnedProvider(config);
    if (pinnedProvider && providerId === pinnedProvider) {
      throw new Error(`Pinned provider ${providerId} is not configured for role ${role.id}. Configure that provider instead of falling back to another one.`);
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
    const pinnedProvider = getPinnedProvider(config);
    if (pinnedProvider && preferredProviderId !== pinnedProvider && preferredProviderId !== "mock") {
      throw new Error(`Provider ${preferredProviderId} is disabled; only ${pinnedProvider} is allowed.`);
    }

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
    const pinnedProvider = getPinnedProvider(config);
    if (pinnedProvider && preferredProviderId === pinnedProvider) {
      return [preferredProviderId];
    }

    const configuredProviders = (["anthropic", "openai", "gemini"] as const)
      .filter((providerId) => this.isProviderUsable(config, providerId));

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

  private isProviderUsable(config: AgentConfig, providerId: Exclude<ProviderId, "mock"> | "mock"): boolean {
    if (providerId === "mock") {
      return true;
    }
    const providerConfig = config.providers[providerId];
    if (!providerConfig?.enabled) {
      return false;
    }
    return this.get(providerId).isConfigured(providerConfig);
  }
}
