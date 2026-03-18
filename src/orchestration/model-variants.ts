/**
 * Model-Variant Prompt System (inspired by cline).
 *
 * Different model families have different strengths and optimal prompting strategies.
 * This module selects the right prompt variant based on the model being used,
 * with automatic fallback to a generic variant.
 *
 * Variant hierarchy:
 * 1. Exact model match (e.g., "claude-opus-4-6")
 * 2. Family match (e.g., "claude")
 * 3. Generic fallback
 */

export type ModelFamily =
  | "claude"
  | "gpt"
  | "gemini"
  | "generic";

export interface ModelVariantConfig {
  family: ModelFamily;
  /** Max tokens to request in response */
  maxOutputTokens: number;
  /** Whether to request structured JSON output */
  preferJson: boolean;
  /** Whether to use chain-of-thought reasoning */
  useChainOfThought: boolean;
  /** System prompt prefix specific to this model family */
  systemPrefix: string;
  /** Tool use instruction style */
  toolInstructionStyle: "xml" | "json" | "function_call";
  /** Whether this model supports cache_control headers */
  supportsCacheControl: boolean;
  /** Temperature for this model family */
  temperature: number;
  /** Whether the model supports parallel tool calls */
  supportsParallelTools: boolean;
}

const VARIANTS: Record<ModelFamily, ModelVariantConfig> = {
  claude: {
    family: "claude",
    maxOutputTokens: 16_384,
    preferJson: true,
    useChainOfThought: true,
    systemPrefix: "You are an expert software engineer. Think step by step before acting. When you need to make changes, use the available tools.",
    toolInstructionStyle: "json",
    supportsCacheControl: true,
    temperature: 0.3,
    supportsParallelTools: true
  },
  gpt: {
    family: "gpt",
    maxOutputTokens: 32_768,
    preferJson: true,
    useChainOfThought: true,
    systemPrefix: "You are an expert software engineer. Analyze the task carefully and produce a structured response using the available tools.",
    toolInstructionStyle: "function_call",
    supportsCacheControl: false,
    temperature: 0.2,
    supportsParallelTools: true
  },
  gemini: {
    family: "gemini",
    maxOutputTokens: 8_192,
    preferJson: true,
    useChainOfThought: true,
    systemPrefix: "You are an expert software engineer. Break down the task and use tools to accomplish it.",
    toolInstructionStyle: "json",
    supportsCacheControl: false,
    temperature: 0.3,
    supportsParallelTools: false
  },
  generic: {
    family: "generic",
    maxOutputTokens: 8_192,
    preferJson: true,
    useChainOfThought: false,
    systemPrefix: "You are a software engineer. Use the available tools to complete the task.",
    toolInstructionStyle: "json",
    supportsCacheControl: false,
    temperature: 0.5,
    supportsParallelTools: false
  }
};

/**
 * Detect model family from model ID string.
 */
export function detectModelFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();

  if (lower.includes("claude") || lower.includes("anthropic")) {
    return "claude";
  }
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.includes("openai")) {
    return "gpt";
  }
  if (lower.includes("gemini") || lower.includes("palm") || lower.includes("google")) {
    return "gemini";
  }

  return "generic";
}

/**
 * Get the variant config for a model.
 */
export function getModelVariant(modelId: string): ModelVariantConfig {
  const family = detectModelFamily(modelId);
  return { ...VARIANTS[family] };
}

/**
 * Get the variant config for a provider ID.
 */
export function getProviderVariant(providerId: string): ModelVariantConfig {
  switch (providerId) {
    case "anthropic":
      return { ...VARIANTS.claude };
    case "openai":
      return { ...VARIANTS.gpt };
    case "gemini":
      return { ...VARIANTS.gemini };
    default:
      return { ...VARIANTS.generic };
  }
}

/**
 * Apply model-variant-specific modifications to a system prompt.
 */
export function applyVariantToPrompt(prompt: string, variant: ModelVariantConfig): string {
  const parts: string[] = [];

  // Add model-specific system prefix
  parts.push(variant.systemPrefix);

  // Add chain-of-thought instruction if supported
  if (variant.useChainOfThought) {
    parts.push("\nThink through each step before taking action. Show your reasoning.");
  }

  // Add JSON output instruction
  if (variant.preferJson) {
    parts.push("\nAlways respond with valid JSON matching the specified schema.");
  }

  // Add the original prompt
  parts.push(`\n\n${prompt}`);

  return parts.join("");
}

/**
 * Get cache control headers for Anthropic models.
 * Implements the SWE-agent workaround for tool-role messages.
 */
export function getCacheControlHeaders(
  variant: ModelVariantConfig,
  messageRole: "system" | "user" | "assistant" | "tool"
): Record<string, unknown> | undefined {
  if (!variant.supportsCacheControl) return undefined;

  // SWE-agent workaround: tool role requires top-level cache_control
  // not content-level cache_control
  if (messageRole === "tool") {
    return { cache_control: { type: "ephemeral" } };
  }

  return undefined;
}
