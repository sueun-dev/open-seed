/**
 * Model Router — Task classification → model selection.
 *
 * Inspired by oh-my-claudecode + oh-my-openagent:
 * - Classify tasks by complexity/type
 * - Route to appropriate model (fast/balanced/powerful)
 * - Fallback chains per category
 * - Cost-aware selection
 */

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex" | "architectural";

export type TaskType =
  | "simple_edit"     // Single file, small change
  | "multi_edit"      // Multiple files, coordinated changes
  | "refactor"        // Structural changes, preserve behavior
  | "debug"           // Find and fix bugs
  | "architecture"    // Design decisions, system design
  | "test"            // Write or fix tests
  | "docs"            // Write documentation
  | "research"        // Explore codebase, answer questions
  | "review";         // Code review

export interface ModelTier {
  id: string;
  tier: "fast" | "balanced" | "powerful";
  /** Models to try in order */
  models: string[];
  /** Max output tokens */
  maxOutputTokens: number;
  /** Use extended thinking if available */
  useThinking: boolean;
}

const MODEL_TIERS: Record<string, ModelTier> = {
  fast: {
    id: "fast",
    tier: "fast",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
    maxOutputTokens: 4096,
    useThinking: false
  },
  balanced: {
    id: "balanced",
    tier: "balanced",
    models: ["gpt-4o", "gpt-4.1", "gpt-5.4"],
    maxOutputTokens: 8192,
    useThinking: false
  },
  powerful: {
    id: "powerful",
    tier: "powerful",
    models: ["gpt-5.4", "gpt-4.1", "gpt-4o"],
    maxOutputTokens: 16384,
    useThinking: true
  }
};

// ─── Task Classification ─────────────────────────────────────────────────────

export function classifyTaskComplexity(task: string): TaskComplexity {
  const lower = task.toLowerCase();
  const wordCount = task.split(/\s+/).length;

  // Trivial: very short, simple operations
  if (wordCount <= 5 && /\b(rename|delete|remove|add\s+import)\b/i.test(lower)) return "trivial";

  // Simple: single file, clear action
  if (wordCount <= 15 && /\b(fix|update|change|add)\b/i.test(lower) && !lower.includes("refactor")) return "simple";

  // Architectural: design, system, architecture keywords
  if (/\b(architect|redesign|system\s+design|migrate|rewrite\s+from|convert\s+to)\b/i.test(lower)) return "architectural";

  // Complex: multiple files, multiple steps
  if (/\b(refactor|restructure|reorganize|implement.*system|build.*from\s+scratch)\b/i.test(lower)) return "complex";

  // Moderate: everything else
  return "moderate";
}

export function classifyTaskType(task: string): TaskType {
  const lower = task.toLowerCase();

  if (/\b(test|spec|coverage|assert)\b/i.test(lower)) return "test";
  if (/\b(doc|readme|comment|explain|jsdoc)\b/i.test(lower)) return "docs";
  if (/\b(review|audit|check|inspect|analyze)\b/i.test(lower)) return "review";
  if (/\b(debug|fix\s+bug|error|crash|broken|failing)\b/i.test(lower)) return "debug";
  if (/\b(refactor|restructure|reorganize|extract|inline)\b/i.test(lower)) return "refactor";
  if (/\b(architect|design|system|migrate|rewrite)\b/i.test(lower)) return "architecture";
  if (/\b(research|explore|find|search|understand|how\s+does)\b/i.test(lower)) return "research";

  // Count file indicators
  const filePatterns = lower.match(/\b\w+\.\w{1,5}\b/g) ?? [];
  if (filePatterns.length > 2) return "multi_edit";

  return "simple_edit";
}

// ─── Model Selection ─────────────────────────────────────────────────────────

export function selectModelTier(task: string): ModelTier {
  const complexity = classifyTaskComplexity(task);
  const taskType = classifyTaskType(task);

  // Architectural + complex → powerful
  if (complexity === "architectural" || (complexity === "complex" && taskType !== "test")) {
    return MODEL_TIERS.powerful;
  }

  // Debug always gets powerful (needs deep reasoning)
  if (taskType === "debug") {
    return MODEL_TIERS.powerful;
  }

  // Trivial → fast
  if (complexity === "trivial") {
    return MODEL_TIERS.fast;
  }

  // Docs, simple edits → fast
  if (taskType === "docs" || (complexity === "simple" && taskType === "simple_edit")) {
    return MODEL_TIERS.fast;
  }

  // Everything else → balanced
  return MODEL_TIERS.balanced;
}

export function selectModelForRole(task: string, roleId: string): ModelTier {
  // Planner always balanced (needs good reasoning but not max)
  if (roleId === "planner") return MODEL_TIERS.balanced;

  // Reviewer can be fast (structured output)
  if (roleId === "reviewer") return MODEL_TIERS.fast;

  // Researcher → balanced
  if (roleId === "researcher") return MODEL_TIERS.balanced;

  // Executor → based on task complexity
  return selectModelTier(task);
}

export function getModelTiers(): Record<string, ModelTier> {
  return { ...MODEL_TIERS };
}

// ─── Prompt Adaptation ───────────────────────────────────────────────────────

export function buildModelRoutingContext(task: string): string {
  const complexity = classifyTaskComplexity(task);
  const taskType = classifyTaskType(task);
  const tier = selectModelTier(task);

  return [
    `Task complexity: ${complexity}`,
    `Task type: ${taskType}`,
    `Model tier: ${tier.tier} (${tier.models[0]})`,
    `Max output: ${tier.maxOutputTokens} tokens`,
    tier.useThinking ? "Extended thinking: enabled" : ""
  ].filter(Boolean).join("\n");
}
