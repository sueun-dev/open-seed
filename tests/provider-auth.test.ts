import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultConfig } from "../src/core/config.js";
import { getProviderAuthStatus, resolveProviderAuth } from "../src/providers/auth.js";

const ORIGINAL_ENV = { ...process.env };

describe("provider auth helpers", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("resolves OpenAI oauth mode and surfaces the direct-api warning", async () => {
    const config = createDefaultConfig().providers.openai;
    config.defaultModel = "gpt-test";
    config.authMode = "oauth";
    process.env.OPENAI_OAUTH_TOKEN = "oauth-openai-token";

    const status = getProviderAuthStatus("openai", config);
    const auth = await resolveProviderAuth("openai", config);

    expect(status.ready).toBe(true);
    expect(auth.headers.authorization).toBe("Bearer oauth-openai-token");
    expect(auth.authMode).toBe("oauth");
    expect(auth.baseUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("adds OpenClaw-style Anthropic oauth beta headers", async () => {
    const config = createDefaultConfig().providers.anthropic;
    config.defaultModel = "claude-test";
    config.authMode = "oauth";
    process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat-test";

    const status = getProviderAuthStatus("anthropic", config);
    const auth = await resolveProviderAuth("anthropic", config);

    expect(status.ready).toBe(true);
    expect(auth.headers.authorization).toBe("Bearer sk-ant-oat-test");
    expect(auth.headers["anthropic-beta"]).toMatch(/oauth-2025-04-20/);
    expect(status.warnings).toContain("Claude Code OAuth bearer mode; ensure the stored Claude session is still valid");
  });

  it("loads Anthropic oauth credentials from Claude Code auth when env is absent", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-home-"));
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-external"
      },
      organizationUuid: "org-uuid-123"
    }), "utf8");
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");

    const config = createDefaultConfig().providers.anthropic;
    config.defaultModel = "claude-test";
    config.authMode = "oauth";

    const status = getProviderAuthStatus("anthropic", config);
    const auth = await resolveProviderAuth("anthropic", config);

    expect(status.ready).toBe(true);
    expect(status.credentialSource).toBe("external");
    expect(auth.sourceType).toBe("external");
    expect(auth.sourcePath).toBe(path.join(home, ".claude", ".credentials.json"));
    expect(auth.headers.authorization).toBe("Bearer sk-ant-oat-external");
    expect(auth.headers["x-organization-uuid"]).toBe("org-uuid-123");
    expect(status.warnings.some((warning) => warning.includes("org:create_api_key"))).toBe(true);
  });

  it("marks Gemini oauth as unsupported", () => {
    const config = createDefaultConfig().providers.gemini;
    config.defaultModel = "gemini-test";
    config.authMode = "oauth";
    process.env.GEMINI_OAUTH_TOKEN = "gemini-oauth";

    const status = getProviderAuthStatus("gemini", config);

    expect(status.ready).toBe(false);
    expect(status.summary).toMatch(/not implemented/i);
  });
});
