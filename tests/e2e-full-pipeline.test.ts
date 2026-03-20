import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentEventBus } from "../src/core/event-bus.js";
import { assessCodebase, verbalizeIntent } from "../src/orchestration/sisyphus.js";
import { analyzeIntent } from "../src/orchestration/intent-gate.js";
import { DiffSandbox } from "../src/tools/diff-sandbox.js";
import { diagnoseError, shouldSelfHeal } from "../src/orchestration/self-heal.js";

function greet(name: string): string {
  return `Hello, ${name}!`;
}

describe("sisyphus pipeline", () => {
  it("should return a hello greeting for the provided name", () => {
    expect(greet("test")).toBe("Hello, test!");
  });

  it("assesses a TypeScript repo as disciplined or transitional", () => {
    const files = [
      "package.json", "tsconfig.json", ".eslintrc.json",
      "src/index.ts", "tests/index.test.ts"
    ];
    const configContents: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "assess-fixture",
        type: "module",
        scripts: { test: "vitest run", build: "tsc --noEmit" },
        devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0", eslint: "^9.0.0" }
      })
    };

    const assessment = assessCodebase(files, configContents);
    expect(["disciplined", "transitional"]).toContain(assessment.maturity);
    expect(assessment.conventions.length).toBeGreaterThan(0);
  });

  it("verbalizes implementation intent with routing", () => {
    const intentAnalysis = analyzeIntent("create a new calculator module");
    const verbalized = verbalizeIntent("create a new calculator module", intentAnalysis);

    // verbalizeIntent produces a trueIntent string and routingDecision
    expect(typeof verbalized.trueIntent).toBe("string");
    expect(verbalized.trueIntent.length).toBeGreaterThan(0);
    expect(typeof verbalized.routingDecision).toBe("string");
    expect(verbalized.routingDecision.length).toBeGreaterThan(0);
  });

  it("event bus fires and listeners receive events", async () => {
    const bus = new AgentEventBus();
    const received: string[] = [];

    bus.on("test.event", async (event) => {
      received.push(String(event.payload?.text ?? ""));
    });

    await bus.fire("test.event", "test-source", "test-session", { text: "hello" });

    expect(received).toEqual(["hello"]);
  });

  it("applies diff sandbox changes to disk", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openseed-diff-cwd-"));
    const stagingDir = mkdtempSync(join(tmpdir(), "openseed-diff-staging-"));
    const sandbox = new DiffSandbox(cwd, stagingDir);

    writeFileSync(join(cwd, "README.md"), "# Original\n");
    const existsBeforeApply = existsSync(join(cwd, "src", "hello.ts"));

    await sandbox.stageWrite("src/hello.ts", 'export const hello = "world";\n');
    await sandbox.stageWrite("README.md", "# Updated\n");

    const result = await sandbox.apply();
    const content = readFileSync(join(cwd, "src", "hello.ts"), "utf8");
    const diskContent = readFileSync(join(cwd, "README.md"), "utf8");

    expect(existsBeforeApply).toBe(false);
    expect(result.applied).toBe(2);
    expect(content).toContain("hello");
    expect(diskContent).toBe("# Updated\n");
  });

  it("classifies failures and determines when auto-fix should run", () => {
    const syntaxDiag = diagnoseError("SyntaxError: Unexpected token }");
    const typeDiag = diagnoseError("TS2304: Cannot find name 'x'");
    const networkDiag = diagnoseError("ECONNRESET while contacting provider");

    expect(syntaxDiag.category).toBe("syntax");
    expect(typeDiag.category).toBe("type");
    expect(networkDiag.category).toBe("network");

    // syntax errors are self-healable
    expect(shouldSelfHeal(syntaxDiag, 1, 3)).toBe(true);
    // network errors trigger retry (self-heal returns true for network)
    expect(shouldSelfHeal(networkDiag, 1, 3)).toBe(true);
  });
});
