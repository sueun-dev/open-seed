import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { ProviderAdapter, ProviderConfig, ProviderInvokeOptions, ProviderRequest, ProviderResponse } from "../src/core/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { runSoakHarness } from "../src/soak/harness.js";

class StubProvider implements ProviderAdapter {
  constructor(
    readonly id: ProviderResponse["provider"],
    private readonly impl: (options?: ProviderInvokeOptions) => Promise<ProviderResponse>
  ) {}

  isConfigured(_config: ProviderConfig | undefined): boolean {
    return true;
  }

  invoke(_config: ProviderConfig | undefined, _request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    return this.impl(options);
  }
}

const ORIGINAL_ENV = { ...process.env };

describe("runSoakHarness", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("runs configured providers in parallel and writes a report", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-soak-"));
    const config = createDefaultConfig();
    config.providers.openai.defaultModel = "gpt-test";
    config.providers.anthropic.defaultModel = "claude-test";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    const registry = new ProviderRegistry({
      openai: new StubProvider("openai", async (options) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        await options?.onTextDelta?.("{", "openai");
        await options?.onTextDelta?.("}", "openai");
        return {
          provider: "openai",
          model: "gpt-test",
          text: "{}",
          metadata: { attempts: 1, streamed: true }
        };
      }),
      anthropic: new StubProvider("anthropic", async (options) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        await options?.onTextDelta?.("{", "anthropic");
        await options?.onTextDelta?.("}", "anthropic");
        return {
          provider: "anthropic",
          model: "claude-test",
          text: "{}",
          metadata: { attempts: 1, streamed: true }
        };
      })
    });

    const startedAt = Date.now();
    const report = await runSoakHarness({
      cwd,
      config,
      registry,
      rounds: 1,
      providers: ["openai", "anthropic"]
    });
    const elapsedMs = Date.now() - startedAt;

    expect(report.providers).toHaveLength(2);
    expect(report.providers.every((result) => result.status === "passed")).toBe(true);
    expect(elapsedMs).toBeLessThan(260);
    await expect(fs.readFile(report.reportPath, "utf8")).resolves.toContain("\"status\": \"passed\"");
  });

  it("skips providers that are not ready", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-soak-skip-"));
    const config = createDefaultConfig();
    config.providers.openai.defaultModel = "gpt-test";

    const report = await runSoakHarness({
      cwd,
      config,
      rounds: 1,
      providers: ["openai"]
    });

    expect(report.providers[0]).toMatchObject({
      providerId: "openai",
      status: "skipped"
    });
  });
});
