import type { AgentConfig, ProviderId, RoleDefinition } from "../core/types.js";

const ROUTING_ORDER = ["execution", "planning", "research", "review", "frontend"] as const;

export function selectProviderForRole(config: AgentConfig, role: RoleDefinition): ProviderId {
  return config.routing.categories[role.category];
}

export function getPinnedProvider(config: AgentConfig): Exclude<ProviderId, "mock"> | null {
  const providers = ROUTING_ORDER.map((category) => config.routing.categories[category]);
  const first = providers[0];
  if (!first || first === "mock") {
    return null;
  }
  return providers.every((provider) => provider === first)
    ? first as Exclude<ProviderId, "mock">
    : null;
}

export function getPrimaryProvider(config: AgentConfig): Exclude<ProviderId, "mock"> {
  const pinned = getPinnedProvider(config);
  if (pinned) {
    return pinned;
  }

  for (const category of ROUTING_ORDER) {
    const provider = config.routing.categories[category];
    if (provider && provider !== "mock") {
      return provider as Exclude<ProviderId, "mock">;
    }
  }

  return "openai";
}

export function getPrimaryModel(config: AgentConfig): string {
  const provider = getPrimaryProvider(config);
  return config.providers[provider]?.defaultModel ?? "gpt-5.4";
}

export function classifyTask(task: string): RoleDefinition["category"] {
  const normalized = task.toLowerCase();
  const explicitStep = normalized.match(/^\[step\s+\d+:\s+([a-z-]+)/);
  if (explicitStep) {
    const stepType = explicitStep[1];
    if (/(build|fix|deploy|custom)/.test(stepType)) {
      return "execution";
    }
    if (/(verify|review)/.test(stepType)) {
      return "review";
    }
    if (/(analyze|debate|design)/.test(stepType)) {
      return "planning";
    }
  }
  if (/\b(frontend|ui|ux|layout|visual|browser|screenshot|css|component)\b/.test(normalized)) {
    return "frontend";
  }
  if (/(research|investigate|analyze|why|root cause|trace)/.test(normalized)) {
    return "research";
  }
  if (/(plan|design|strategy|roadmap|architecture)/.test(normalized)) {
    return "planning";
  }
  return "execution";
}
