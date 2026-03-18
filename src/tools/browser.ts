export type BrowserAction = "open" | "click" | "type" | "screenshot" | "console" | "network";

export interface BrowserHealth {
  available: boolean;
  reason?: string;
  smokeTested?: boolean;
  canLaunch?: boolean;
  executablePath?: string;
}

export interface BrowserHealthOptions {
  smokeTest?: boolean;
  executablePath?: string;
  headless?: boolean;
}

export async function loadPlaywrightCore(): Promise<typeof import("playwright-core")> {
  return import("playwright-core");
}

export async function getBrowserHealth(options: BrowserHealthOptions = {}): Promise<BrowserHealth> {
  try {
    const playwright = await loadPlaywrightCore();
    const executablePath = options.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

    if (!options.smokeTest) {
      return {
        available: true,
        executablePath
      };
    }

    const browser = await playwright.chromium.launch({
      headless: options.headless ?? true,
      executablePath
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("data:text/html,<title>agent40-smoke</title><h1>ok</h1>", {
        waitUntil: "domcontentloaded",
        timeout: 10_000
      });
    } finally {
      await browser.close();
    }

    return {
      available: true,
      smokeTested: true,
      canLaunch: true,
      executablePath
    };
  } catch (error) {
    return {
      available: false,
      smokeTested: options.smokeTest === true,
      canLaunch: options.smokeTest ? false : undefined,
      executablePath: options.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function assertAllowedBrowserAction(action: BrowserAction): void {
  if (!["open", "click", "type", "screenshot", "console", "network"].includes(action)) {
    throw new Error(`Unsupported browser action: ${action}`);
  }
}
