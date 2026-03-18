import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../core/utils.js";
import { getSoakDir } from "../core/paths.js";
import type { AgentConfig, ProviderAdapter, ProviderId, ProviderRequest, ProviderResponse } from "../core/types.js";
import { getProviderAuthStatus } from "../providers/auth.js";
import { ProviderRegistry } from "../providers/registry.js";

export interface SoakResult {
  providerId: Exclude<ProviderId, "mock">;
  status: "passed" | "failed" | "skipped";
  authMode: "api_key" | "oauth";
  summary: string;
  rounds: number;
  durationMs: number;
  firstChunkMs?: number;
  streamChunks: number;
  characters: number;
  attempts: number;
  streamed: boolean;
  warnings: string[];
  model?: string;
  responsePreview?: string;
  usage?: ProviderResponse["usage"];
  error?: string;
}

export interface SoakReport {
  createdAt: string;
  cwd: string;
  providers: SoakResult[];
  reportPath: string;
}

export interface SoakHarnessOptions {
  cwd: string;
  config: AgentConfig;
  providers?: Array<Exclude<ProviderId, "mock">>;
  rounds?: number;
  prompt?: string;
  registry?: ProviderRegistry;
}

export async function runSoakHarness(options: SoakHarnessOptions): Promise<SoakReport> {
  const providers = options.providers ?? ["openai", "anthropic", "gemini"];
  const rounds = Math.max(1, options.rounds ?? 2);
  const prompt = options.prompt ?? 'Return JSON exactly like {"status":"ok","streaming":true}.';
  const registry = options.registry ?? new ProviderRegistry();

  const results = await Promise.all(
    providers.map((providerId) => runProviderSoak({
      providerId,
      config: options.config,
      registry,
      prompt,
      rounds
    }))
  );

  const soakDir = getSoakDir(options.cwd, options.config.sessions.localDirName);
  await ensureDir(soakDir);
  const fileName = `${new Date().toISOString().replaceAll(":", "-")}.json`;
  const reportPath = path.join(soakDir, fileName);
  const report: SoakReport = {
    createdAt: new Date().toISOString(),
    cwd: options.cwd,
    providers: results,
    reportPath
  };

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function runProviderSoak(params: {
  providerId: Exclude<ProviderId, "mock">;
  config: AgentConfig;
  registry: ProviderRegistry;
  prompt: string;
  rounds: number;
}): Promise<SoakResult> {
  const providerConfig = params.config.providers[params.providerId];
  const auth = getProviderAuthStatus(params.providerId, providerConfig);
  if (!auth.ready) {
    return {
      providerId: params.providerId,
      status: "skipped",
      authMode: auth.authMode,
      summary: auth.summary,
      rounds: 0,
      durationMs: 0,
      streamChunks: 0,
      characters: 0,
      attempts: 0,
      streamed: false,
      warnings: auth.warnings
    };
  }

  const adapter = params.registry.get(params.providerId) as ProviderAdapter;
  const startedAt = performance.now();
  let firstChunkMs: number | undefined;
  let chunks = 0;
  let characters = 0;
  let attempts = 0;
  let streamed = false;
  let lastResponse: ProviderResponse | undefined;

  try {
    for (let round = 0; round < params.rounds; round += 1) {
      const roundStartedAt = performance.now();
      lastResponse = await adapter.invoke(providerConfig, buildRequest(params.providerId, params.prompt), {
        async onTextDelta(chunk) {
          chunks += 1;
          characters += chunk.length;
          if (firstChunkMs === undefined) {
            firstChunkMs = performance.now() - roundStartedAt;
          }
        }
      });
      attempts += lastResponse.metadata?.attempts ?? 1;
      streamed = streamed || Boolean(lastResponse.metadata?.streamed);
      if (chunks === 0) {
        characters += lastResponse.text.length;
      }
    }

    return {
      providerId: params.providerId,
      status: "passed",
      authMode: auth.authMode,
      summary: auth.summary,
      rounds: params.rounds,
      durationMs: Math.round(performance.now() - startedAt),
      firstChunkMs: firstChunkMs === undefined ? undefined : Math.round(firstChunkMs),
      streamChunks: chunks,
      characters,
      attempts,
      streamed,
      warnings: Array.from(new Set([
        ...auth.warnings,
        ...(lastResponse?.metadata?.warnings ?? [])
      ])),
      model: lastResponse?.model,
      responsePreview: truncatePreview(lastResponse?.text ?? ""),
      usage: lastResponse?.usage
    };
  } catch (error) {
    return {
      providerId: params.providerId,
      status: "failed",
      authMode: auth.authMode,
      summary: auth.summary,
      rounds: params.rounds,
      durationMs: Math.round(performance.now() - startedAt),
      firstChunkMs: firstChunkMs === undefined ? undefined : Math.round(firstChunkMs),
      streamChunks: chunks,
      characters,
      attempts,
      streamed,
      warnings: auth.warnings,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildRequest(providerId: Exclude<ProviderId, "mock">, prompt: string): ProviderRequest {
  return {
    role: "researcher",
    category: providerId === "anthropic" ? "research" : "execution",
    systemPrompt: "You are a provider soak test. Return compact JSON only.",
    prompt,
    responseFormat: "json"
  };
}

function truncatePreview(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
