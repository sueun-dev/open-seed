import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const browserState = {
  currentUrl: "about:blank",
  title: "Mock Page"
};

vi.mock("../src/tools/browser.js", async () => {
  return {
    assertAllowedBrowserAction(action: string) {
      if (!["open", "click", "type", "screenshot", "console", "network"].includes(action)) {
        throw new Error(`Unsupported browser action: ${action}`);
      }
    },
    async getBrowserHealth() {
      return { available: true };
    },
    async loadPlaywrightCore() {
      return {
        chromium: {
          async launch() {
            return {
              async newContext() {
                return {
                  async newPage() {
                    return {
                      on() {},
                      async goto(url: string) {
                        browserState.currentUrl = url;
                      },
                      url() {
                        return browserState.currentUrl;
                      },
                      async title() {
                        return browserState.title;
                      },
                      async waitForTimeout() {},
                      async screenshot(options: { path: string }) {
                        await fs.mkdir(path.dirname(options.path), { recursive: true });
                        await fs.writeFile(options.path, "mock-image", "utf8");
                      },
                      locator() {
                        return {
                          async click() {},
                          async fill() {}
                        };
                      },
                      keyboard: {
                        async press() {}
                      }
                    };
                  },
                  async storageState(options: { path: string }) {
                    await fs.mkdir(path.dirname(options.path), { recursive: true });
                    await fs.writeFile(options.path, "{}", "utf8");
                  }
                };
              },
              async close() {}
            };
          }
        }
      };
    }
  };
});

import { createDefaultConfig, writeDefaultConfig } from "../src/core/config.js";
import { ApprovalEngine } from "../src/safety/approval.js";
import { getRoleRegistry, resolveRole } from "../src/roles/registry.js";
import { SessionStore } from "../src/sessions/store.js";
import { readLatestBrowserCheckpoint } from "../src/tools/browser-session.js";
import { ToolRuntime } from "../src/tools/runtime.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-browser-runtime-"));
  tempDirs.push(cwd);
  await writeDefaultConfig(cwd);
  return cwd;
}

afterEach(async () => {
  browserState.currentUrl = "about:blank";
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("browser runtime", () => {
  it("reuses the latest checkpoint url for follow-up browser actions", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("browser session reuse");
    const role = resolveRole(getRoleRegistry(config), "frontend-engineer");
    const runtime = new ToolRuntime({
      cwd,
      config,
      role,
      sessionId: session.id,
      sessionStore: store,
      approvalEngine: new ApprovalEngine(config.safety)
    });

    const openResult = await runtime.execute({
      name: "browser",
      reason: "Open a mock page",
      input: {
        action: "open",
        sessionName: "checkout",
        url: "https://example.com/checkout"
      }
    });
    const screenshotResult = await runtime.execute({
      name: "browser",
      reason: "Capture the same page without respecifying the url",
      input: {
        action: "screenshot",
        sessionName: "checkout",
        outputPath: ".agent/browser/mock-shot.png"
      }
    });

    expect(openResult.ok).toBe(true);
    expect(screenshotResult.ok).toBe(true);
    expect(await fs.readFile(path.join(cwd, ".agent", "browser", "mock-shot.png"), "utf8")).toBe("mock-image");

    const checkpoint = await readLatestBrowserCheckpoint(cwd, ".agent", session.id, "checkout");
    expect(checkpoint?.action).toBe("screenshot");
    expect(checkpoint?.url).toBe("https://example.com/checkout");
  });
});
