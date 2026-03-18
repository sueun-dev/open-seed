/**
 * Direct OpenAI call — bypasses engine, calls provider directly.
 * Find out exactly WHY the API call fails.
 */
import { describe, it, expect } from "vitest";
import { loadOpenAICodexCliAuth } from "../src/providers/external-auth.js";
import { OpenAIProviderAdapter } from "../src/providers/openai.js";
import { resolveProviderAuth } from "../src/providers/auth.js";

const hasAuth = (() => {
  try { return loadOpenAICodexCliAuth() !== null; } catch { return false; }
})();

describe.skipIf(!hasAuth)("Direct OpenAI Provider Call", () => {
  it("calls OpenAI Codex OAuth directly and prints result", async () => {
    const config = {
      enabled: true,
      apiKeyEnv: "OPENAI_API_KEY",
      authMode: "oauth" as const,
      oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
      defaultModel: "gpt-5.4",
      timeoutMs: 60000,
      maxRetries: 1
    };

    // Step 1: Resolve auth
    let auth;
    try {
      auth = await resolveProviderAuth("openai", config);
      console.log("Auth resolved:", {
        authMode: auth.authMode,
        sourceType: auth.sourceType,
        baseUrl: auth.baseUrl,
        hasToken: !!auth.token,
        tokenPrefix: auth.token.slice(0, 20) + "...",
        headers: Object.keys(auth.headers)
      });
    } catch (e) {
      console.error("AUTH FAILED:", e);
      throw e;
    }

    // Step 2: Call the provider
    const adapter = new OpenAIProviderAdapter();
    let chunks = "";

    try {
      const response = await adapter.invoke(config, {
        role: "executor",
        category: "execution",
        systemPrompt: "You are a TypeScript expert. Return valid JSON only.",
        prompt: 'Write a deleteTodo function that removes a todo by id from a Map. Return JSON: {"summary": "done", "kind": "execution", "changes": ["added deleteTodo"], "toolCalls": []}',
        responseFormat: "json"
      }, {
        onTextDelta: async (chunk) => {
          chunks += chunk;
        }
      });

      console.log("\n✅ API CALL SUCCEEDED");
      console.log("Provider:", response.provider);
      console.log("Model:", response.model);
      console.log("Usage:", response.usage);
      console.log("Auth mode:", response.metadata?.authMode);
      console.log("Text length:", response.text.length);
      console.log("Text preview:", response.text.slice(0, 300));
      console.log("Streamed chunks:", chunks.length, "chars");

      expect(response.text.length).toBeGreaterThan(0);
      expect(response.provider).toBe("openai");
    } catch (e) {
      console.error("\n❌ API CALL FAILED");
      console.error("Error:", e);
      console.error("Type:", (e as Error).constructor.name);
      console.error("Message:", (e as Error).message);
      throw e;
    }
  }, 60_000);
});
