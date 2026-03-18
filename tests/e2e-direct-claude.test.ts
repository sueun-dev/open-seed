/**
 * Direct Claude call — verifies Anthropic OAuth works via Keychain.
 */
import { describe, it, expect } from "vitest";
import { loadAnthropicClaudeCliAuth } from "../src/providers/external-auth.js";
import { AnthropicProviderAdapter } from "../src/providers/anthropic.js";
import { getProviderAuthStatus } from "../src/providers/auth.js";

const hasAuth = (() => {
  // Skip when running inside Claude Code (nested session would crash)
  if (process.env.CLAUDECODE) return false;
  try { return loadAnthropicClaudeCliAuth() !== null; } catch { return false; }
})();

describe.skipIf(!hasAuth)("Direct Claude Provider Call", () => {
  it("calls Claude via OAuth and prints result", async () => {
    const config = {
      enabled: true,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      authMode: "oauth" as const,
      oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN",
      defaultModel: "claude-opus-4-6",
      timeoutMs: 60000,
      maxRetries: 1
    };

    // Check auth status
    const status = getProviderAuthStatus("anthropic", config);
    console.log("\nClaude Auth Status:", JSON.stringify(status, null, 2));

    expect(status.ready).toBe(true);

    // Call the provider
    const adapter = new AnthropicProviderAdapter();
    let chunks = "";

    const response = await adapter.invoke(config, {
      role: "executor",
      category: "execution",
      systemPrompt: "You are a TypeScript expert. Return valid JSON only.",
      prompt: 'Write a deleteTodo function. Return JSON: {"summary": "added deleteTodo", "kind": "execution", "changes": ["added deleteTodo"], "toolCalls": []}',
      responseFormat: "json"
    }, {
      onTextDelta: async (chunk) => { chunks += chunk; }
    });

    console.log("\n✅ CLAUDE API CALL SUCCEEDED");
    console.log("Provider:", response.provider);
    console.log("Model:", response.model);
    console.log("Usage:", response.usage);
    console.log("Auth mode:", response.metadata?.authMode);
    console.log("Text length:", response.text.length);
    console.log("Text preview:", response.text.slice(0, 300));

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.provider).toBe("anthropic");
  }, 60_000);
});
