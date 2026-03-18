import type { AgentConfig, ProviderId, RoleDefinition } from "../core/types.js";

export function selectProviderForRole(config: AgentConfig, role: RoleDefinition): ProviderId {
  return config.routing.categories[role.category];
}

export function classifyTask(task: string): RoleDefinition["category"] {
  const normalized = task.toLowerCase();
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
