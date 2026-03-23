import process from "node:process";

import { loadConfig } from "../core/config.js";
import { fileExists } from "../core/utils.js";
import { getProviderAuthStatus } from "../providers/auth.js";
import { ProviderRegistry } from "../providers/registry.js";
import { getRoleRegistry } from "../roles/registry.js";
import { SessionStore } from "../sessions/store.js";
import { getBrowserHealth } from "../tools/browser.js";
import { detectTmuxAvailability } from "../orchestration/worker-manager.js";

export async function runDoctorCommand(): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const store = new SessionStore(cwd, config.sessions);
  await store.ensure();
  const providers = new ProviderRegistry();
  const shouldRunBrowserSmoke = config.browser.doctorSmokeTest === true
    || process.env.AGENT40_BROWSER_SMOKE_TEST === "1"
    || Boolean(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  const browser = await getBrowserHealth({
    smokeTest: shouldRunBrowserSmoke,
    headless: config.browser.headless
  });
  const roles = getRoleRegistry(config);
  const sessionsPath = `${cwd}/${config.sessions.localDirName}`;

  const rows: Array<[string, string]> = [
    ["node", process.version],
    ["config", (await fileExists(`${sessionsPath}/config.json`)) ? "ok" : "missing"],
    ["root AGENTS.md", (await fileExists(`${cwd}/AGENTS.md`)) ? "ok" : "missing"],
    ["tmux", detectTmuxAvailability() ? "available" : "fallback=subprocess"],
    ["browser", formatBrowserHealth(browser)],
    ["active roles", roles.filter((role) => role.active).map((role) => role.id).join(", ")]
  ];

  for (const providerId of ["openai"] as const) {
    const adapter = providers.get(providerId);
    const auth = getProviderAuthStatus(providerId, config.providers[providerId]);
    const state = adapter.isConfigured(config.providers[providerId]) ? "configured" : "mock fallback";
    rows.push([`provider:${providerId}`, `${state}; ${auth.summary}`]);
  }

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(16)} ${value}`);
  }
}

function formatBrowserHealth(browser: Awaited<ReturnType<typeof getBrowserHealth>>): string {
  const executableText = browser.executablePath ? ` executable=${browser.executablePath}` : "";
  if (browser.available) {
    if (browser.smokeTested) {
      return `available; smoke=ok${executableText}`;
    }
    return `available; smoke=skipped${executableText}`;
  }
  if (browser.smokeTested) {
    return `unavailable; smoke=failed${executableText}: ${browser.reason ?? "unknown"}`;
  }
  return `unavailable: ${browser.reason ?? "unknown"}`;
}
