import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadAnthropicClaudeCliAuth,
  loadOpenAICodexCliAuth,
  resolveAnthropicClaudeCliAuth
} from "../src/providers/external-auth.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_CLAUDE_CODE_OAUTH_CLIENT_ID = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
const ORIGINAL_FETCH = globalThis.fetch;

describe("external auth loaders", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
    }
    if (ORIGINAL_CLAUDE_CODE_OAUTH_CLIENT_ID === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
    } else {
      process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = ORIGINAL_CLAUDE_CODE_OAUTH_CLIENT_ID;
    }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("loads Codex CLI OAuth credentials without exposing raw structure assumptions elsewhere", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-home-"));
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(home, ".codex", "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-03-16T00:00:00Z",
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct-123"
      }
    }), "utf8");
    process.env.HOME = home;

    const creds = loadOpenAICodexCliAuth();

    expect(creds).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountId: "acct-123",
      authMode: "chatgpt"
    });
  });

  it("loads Claude Code OAuth credentials from the config directory plaintext fallback", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-home-"));
    const claudeDir = path.join(home, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-access-token",
        refreshToken: "sk-ant-oat-refresh-token",
        expiresAt: 1773709860592,
        scopes: ["user:profile", "user:inference"],
        subscriptionType: "pro",
        rateLimitTier: "build-tier"
      },
      organizationUuid: "org-uuid-123"
    }), "utf8");
    process.env.HOME = home;

    const creds = loadAnthropicClaudeCliAuth();

    expect(creds).toMatchObject({
      accessToken: "sk-ant-oat-access-token",
      refreshToken: "sk-ant-oat-refresh-token",
      expiresAt: 1773709860592,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "pro",
      rateLimitTier: "build-tier",
      organizationUuid: "org-uuid-123",
      source: path.join(claudeDir, ".credentials.json")
    });
  });

  it("respects CLAUDE_CONFIG_DIR for Claude Code OAuth credentials", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-home-"));
    const claudeDir = path.join(home, "claude-config");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-custom-access"
      }
    }), "utf8");
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;

    const creds = loadAnthropicClaudeCliAuth();

    expect(creds?.accessToken).toBe("sk-ant-oat-custom-access");
    expect(creds?.source).toBe(path.join(claudeDir, ".credentials.json"));
  });

  it("refreshes expired Claude Code OAuth credentials before returning them", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-home-"));
    const claudeDir = path.join(home, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-expired",
        refreshToken: "sk-ant-oat-refresh",
        expiresAt: Date.now() - 1_000
      }
    }), "utf8");
    process.env.HOME = home;
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = "client-id-123";
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "sk-ant-oat-fresh",
      refresh_token: "sk-ant-oat-refresh-next",
      expires_in: 3600,
      scope: "user:profile user:inference"
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }));

    const creds = await resolveAnthropicClaudeCliAuth();

    expect(creds?.accessToken).toBe("sk-ant-oat-fresh");
    expect(creds?.refreshToken).toBe("sk-ant-oat-refresh-next");
    expect(creds?.scopes).toEqual(["user:profile", "user:inference"]);
    expect(creds?.expiresAt).toBeTypeOf("number");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
  });
});
