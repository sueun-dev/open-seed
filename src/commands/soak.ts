import process from "node:process";

import { loadConfig } from "../core/config.js";
import type { ProviderId } from "../core/types.js";
import { runSoakHarness } from "../soak/harness.js";

export async function runSoakCommand(
  providerList = "openai,anthropic,gemini",
  roundsValue = "2",
  prompt?: string
): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const providers = parseProviders(providerList);
  const rounds = Number.parseInt(roundsValue, 10);
  const report = await runSoakHarness({
    cwd,
    config,
    providers,
    rounds: Number.isFinite(rounds) ? rounds : 2,
    prompt
  });

  for (const result of report.providers) {
    const parts = [
      `${result.providerId}`.padEnd(10),
      `${result.status}`.padEnd(7),
      `${result.authMode}`.padEnd(7),
      `rounds=${result.rounds}`,
      `duration=${result.durationMs}ms`,
      `chunks=${result.streamChunks}`,
      `attempts=${result.attempts}`
    ];
    if (result.firstChunkMs !== undefined) {
      parts.push(`firstChunk=${result.firstChunkMs}ms`);
    }
    if (result.error) {
      parts.push(`error=${result.error}`);
    } else if (result.model) {
      parts.push(`model=${result.model}`);
    }
    console.log(parts.join(" "));
    if (result.warnings.length > 0) {
      console.log(`  warning: ${result.warnings.join(" | ")}`);
    }
  }

  console.log(`report saved to ${report.reportPath}`);
}

function parseProviders(providerList: string): Array<Exclude<ProviderId, "mock">> {
  const allowed = new Set<Exclude<ProviderId, "mock">>(["openai", "anthropic", "gemini"]);
  return providerList
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is Exclude<ProviderId, "mock"> => allowed.has(value as Exclude<ProviderId, "mock">));
}
