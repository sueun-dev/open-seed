import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { ProviderRequest } from "../src/core/types.js";
import { AnthropicProviderAdapter } from "../src/providers/anthropic.js";

const ORIGINAL_ENV = { ...process.env };

const request: ProviderRequest = {
  role: "researcher",
  category: "research",
  systemPrompt: "Return compact JSON only.",
  prompt: "Respond with {\"ok\":true}",
  responseFormat: "json"
};

describe("AnthropicProviderAdapter oauth mode", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses local Claude CLI transport for external oauth credentials", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-anthropic-oauth-home-"));
    const claudeDir = path.join(home, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-external"
      }
    }), "utf8");
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;

    const config = createDefaultConfig().providers.anthropic;
    config.defaultModel = "claude-sonnet-4-5";
    config.authMode = "oauth";

    const cliRunner = vi.fn().mockImplementation(async ({ onTextDelta }) => {
      await onTextDelta?.("```json\n", "anthropic");
      await onTextDelta?.("{\"ok\":true}\n```", "anthropic");
      return {
        text: "```json\n{\"ok\":true}\n```",
        streamed: true
      };
    });

    const adapter = new AnthropicProviderAdapter(undefined, cliRunner);
    const chunks: string[] = [];
    const result = await adapter.invoke(config, request, {
      onTextDelta(chunk) {
        chunks.push(chunk);
      }
    });

    expect(cliRunner).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("{\"ok\":true}");
    expect(result.metadata?.authMode).toBe("oauth");
    expect(result.metadata?.warnings).toContain("Anthropic OAuth is using local Claude CLI transport");
    expect(chunks.join("")).toContain("{\"ok\":true}");
  });
});
