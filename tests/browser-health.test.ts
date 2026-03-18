import { afterEach, describe, expect, it, vi } from "vitest";

const browserMockState = {
  failLaunch: false
};

vi.mock("playwright-core", () => {
  return {
    chromium: {
      async launch() {
        if (browserMockState.failLaunch) {
          throw new Error("mock launch failed");
        }
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() {}
                };
              }
            };
          },
          async close() {}
        };
      }
    }
  };
});

describe("browser health", () => {
  afterEach(() => {
    browserMockState.failLaunch = false;
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  });

  it("reports import-only availability when smoke is skipped", async () => {
    const { getBrowserHealth } = await import("../src/tools/browser.js");
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/mock/chromium";

    const health = await getBrowserHealth();

    expect(health).toMatchObject({
      available: true,
      executablePath: "/mock/chromium"
    });
    expect(health.smokeTested).toBeUndefined();
  });

  it("runs a browser smoke launch when requested", async () => {
    const { getBrowserHealth } = await import("../src/tools/browser.js");
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/mock/chromium";

    const health = await getBrowserHealth({ smokeTest: true });

    expect(health).toMatchObject({
      available: true,
      smokeTested: true,
      canLaunch: true,
      executablePath: "/mock/chromium"
    });
  });

  it("surfaces launch failures during smoke testing", async () => {
    const { getBrowserHealth } = await import("../src/tools/browser.js");
    browserMockState.failLaunch = true;

    const health = await getBrowserHealth({ smokeTest: true });

    expect(health.available).toBe(false);
    expect(health.smokeTested).toBe(true);
    expect(health.canLaunch).toBe(false);
    expect(health.reason).toContain("mock launch failed");
  });
});
