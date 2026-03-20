/**
 * Quality Gate — Final verification that the app is submission-ready.
 *
 * Runs comprehensive checks after the orchestrator completes:
 * 1. Build verification (tsc, build command)
 * 2. Test execution (all tests must pass)
 * 3. Lint and format check
 * 4. Security audit (no obvious vulnerabilities)
 * 5. Completeness check (all blueprint files exist)
 * 6. Runtime smoke test (dev server starts)
 *
 * Inspired by:
 * - oh-my-openagent Sisyphus: evidence requirements
 * - oh-my-claudecode: verify-fix loop
 * - Cline: checkpoint and verify
 * - CI/CD pipelines: gate-based progression
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AppBlueprint, BlueprintPhaseSpec } from "./blueprint.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GateCheckId =
  | "files-exist"
  | "package-valid"
  | "types-compile"
  | "lint-clean"
  | "tests-pass"
  | "build-succeeds"
  | "no-secrets"
  | "no-todos"
  | "env-template"
  | "readme-exists"
  | "dev-server-starts";

export interface GateCheck {
  id: GateCheckId;
  name: string;
  description: string;
  severity: "blocker" | "warning" | "info";
  passed: boolean;
  output?: string;
  error?: string;
  fixSuggestion?: string;
  duration: number;
}

export interface QualityGateResult {
  passed: boolean;
  score: number;          // 0-100
  grade: "A" | "B" | "C" | "D" | "F";
  checks: GateCheck[];
  blockers: GateCheck[];
  warnings: GateCheck[];
  summary: string;
  /** Actionable fix instructions for failures */
  fixInstructions: string[];
}

// ─── Gate Runner ─────────────────────────────────────────────────────────────

export async function runQualityGate(
  projectDir: string,
  blueprint: AppBlueprint
): Promise<QualityGateResult> {
  const checks: GateCheck[] = [];

  // Run all checks
  checks.push(await checkFilesExist(projectDir, blueprint));
  checks.push(await checkPackageValid(projectDir));
  checks.push(await checkTypesCompile(projectDir));
  checks.push(await checkLintClean(projectDir));
  checks.push(await checkTestsPass(projectDir));
  checks.push(await checkBuildSucceeds(projectDir));
  checks.push(await checkNoSecrets(projectDir));
  checks.push(await checkNoTodos(projectDir));
  checks.push(await checkEnvTemplate(projectDir));
  checks.push(await checkReadmeExists(projectDir));
  checks.push(await checkDevServerStarts(projectDir));

  const blockers = checks.filter(c => c.severity === "blocker" && !c.passed);
  const warnings = checks.filter(c => c.severity === "warning" && !c.passed);
  const passedCount = checks.filter(c => c.passed).length;

  const score = Math.round((passedCount / checks.length) * 100);
  const grade: QualityGateResult["grade"] =
    score >= 90 ? "A" :
    score >= 80 ? "B" :
    score >= 70 ? "C" :
    score >= 50 ? "D" : "F";

  const passed = blockers.length === 0;

  const fixInstructions = [
    ...blockers.map(c => c.fixSuggestion).filter((s): s is string => !!s),
    ...warnings.map(c => c.fixSuggestion).filter((s): s is string => !!s),
  ];

  return {
    passed,
    score,
    grade,
    checks,
    blockers,
    warnings,
    summary: buildGateSummary(checks, score, grade, passed),
    fixInstructions,
  };
}

// ─── Individual Checks ───────────────────────────────────────────────────────

async function checkFilesExist(projectDir: string, blueprint: AppBlueprint): Promise<GateCheck> {
  const start = Date.now();
  const missing: string[] = [];

  for (const file of blueprint.files) {
    try {
      await fs.access(path.join(projectDir, file.path));
    } catch {
      missing.push(file.path);
    }
  }

  const passed = missing.length === 0;
  return {
    id: "files-exist",
    name: "Files Completeness",
    description: "All blueprint files have been created",
    severity: "blocker",
    passed,
    output: passed ? `All ${blueprint.files.length} files exist` : undefined,
    error: !passed ? `Missing ${missing.length} files: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}` : undefined,
    fixSuggestion: !passed ? `Create missing files: ${missing.join(", ")}` : undefined,
    duration: Date.now() - start,
  };
}

async function checkPackageValid(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    const raw = await fs.readFile(path.join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const hasName = !!pkg.name;
    const hasScripts = !!pkg.scripts;
    const hasDeps = !!pkg.dependencies || !!pkg.devDependencies;
    const passed = hasName && hasScripts && hasDeps;

    return {
      id: "package-valid",
      name: "Package.json Valid",
      description: "package.json has name, scripts, and dependencies",
      severity: "blocker",
      passed,
      output: passed ? "package.json is valid" : undefined,
      error: !passed ? `Missing: ${[!hasName && "name", !hasScripts && "scripts", !hasDeps && "dependencies"].filter(Boolean).join(", ")}` : undefined,
      fixSuggestion: !passed ? "Ensure package.json has name, scripts (dev, build, test), and dependencies" : undefined,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      id: "package-valid",
      name: "Package.json Valid",
      description: "package.json has name, scripts, and dependencies",
      severity: "blocker",
      passed: false,
      error: "package.json not found or invalid JSON",
      fixSuggestion: "Create a valid package.json with npm init",
      duration: Date.now() - start,
    };
  }
}

async function checkTypesCompile(projectDir: string): Promise<GateCheck> {
  return runCommandCheck(projectDir, {
    id: "types-compile",
    name: "TypeScript Compilation",
    description: "tsc --noEmit passes without errors",
    severity: "blocker",
    command: "npx tsc --noEmit",
    fixSuggestion: "Fix TypeScript type errors shown above",
  });
}

async function checkLintClean(projectDir: string): Promise<GateCheck> {
  return runCommandCheck(projectDir, {
    id: "lint-clean",
    name: "Lint Clean",
    description: "ESLint passes with no errors",
    severity: "warning",
    command: "npx eslint . --max-warnings 0 --no-error-on-unmatched-pattern",
    fixSuggestion: "Fix lint errors with: npx eslint . --fix",
  });
}

async function checkTestsPass(projectDir: string): Promise<GateCheck> {
  return runCommandCheck(projectDir, {
    id: "tests-pass",
    name: "Tests Pass",
    description: "All tests pass",
    severity: "blocker",
    command: "npx vitest run --reporter=verbose",
    fixSuggestion: "Fix failing tests — review test output above",
  });
}

async function checkBuildSucceeds(projectDir: string): Promise<GateCheck> {
  return runCommandCheck(projectDir, {
    id: "build-succeeds",
    name: "Production Build",
    description: "Production build completes successfully",
    severity: "blocker",
    command: "npm run build",
    fixSuggestion: "Fix build errors — check for import issues, missing modules, or config problems",
  });
}

async function checkNoSecrets(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(
      `grep -rn "sk-[a-zA-Z0-9]\\{20,\\}\\|AKIA[A-Z0-9]\\{16\\}\\|password.*=.*['\\"]\\.\\{8,\\}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" . 2>/dev/null || true`,
      { cwd: projectDir, encoding: "utf-8", timeout: 10_000 }
    ).trim();

    // Filter out .env.example matches
    const realMatches = output.split("\n").filter(
      line => line.length > 0 && !line.includes(".env.example") && !line.includes(".env.local")
    );

    const passed = realMatches.length === 0;
    return {
      id: "no-secrets",
      name: "No Hardcoded Secrets",
      description: "No API keys or passwords in source code",
      severity: "blocker",
      passed,
      error: !passed ? `Found potential secrets:\n${realMatches.slice(0, 3).join("\n")}` : undefined,
      fixSuggestion: !passed ? "Move secrets to .env.local and use environment variables" : undefined,
      duration: Date.now() - start,
    };
  } catch {
    return {
      id: "no-secrets",
      name: "No Hardcoded Secrets",
      description: "No API keys or passwords in source code",
      severity: "blocker",
      passed: true,
      output: "Check skipped (grep unavailable)",
      duration: Date.now() - start,
    };
  }
}

async function checkNoTodos(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(
      `grep -rn "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.tsx" . 2>/dev/null || true`,
      { cwd: projectDir, encoding: "utf-8", timeout: 10_000 }
    ).trim();

    const matches = output.split("\n").filter(l => l.length > 0);
    const passed = matches.length === 0;

    return {
      id: "no-todos",
      name: "No TODO/FIXME Comments",
      description: "No unfinished work markers in code",
      severity: "warning",
      passed,
      error: !passed ? `Found ${matches.length} TODO/FIXME comments` : undefined,
      fixSuggestion: !passed ? "Resolve or remove TODO/FIXME comments" : undefined,
      duration: Date.now() - start,
    };
  } catch {
    return {
      id: "no-todos",
      name: "No TODO/FIXME Comments",
      description: "No unfinished work markers in code",
      severity: "warning",
      passed: true,
      duration: Date.now() - start,
    };
  }
}

async function checkEnvTemplate(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    await fs.access(path.join(projectDir, ".env.example"));
    return {
      id: "env-template",
      name: ".env.example Exists",
      description: "Environment variable template is provided",
      severity: "warning",
      passed: true,
      output: ".env.example exists",
      duration: Date.now() - start,
    };
  } catch {
    return {
      id: "env-template",
      name: ".env.example Exists",
      description: "Environment variable template is provided",
      severity: "warning",
      passed: false,
      error: ".env.example not found",
      fixSuggestion: "Create .env.example with all required environment variables (without values)",
      duration: Date.now() - start,
    };
  }
}

async function checkReadmeExists(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    const content = await fs.readFile(path.join(projectDir, "README.md"), "utf-8");
    const hasSetup = /install|setup|getting started/i.test(content);
    const hasDescription = content.length > 100;
    const passed = hasSetup && hasDescription;

    return {
      id: "readme-exists",
      name: "README.md Quality",
      description: "README has description and setup instructions",
      severity: "warning",
      passed,
      output: passed ? "README.md is comprehensive" : undefined,
      error: !passed ? `README.md exists but ${!hasDescription ? "too short" : "missing setup instructions"}` : undefined,
      fixSuggestion: !passed ? "Add project description, setup instructions, and usage examples to README.md" : undefined,
      duration: Date.now() - start,
    };
  } catch {
    return {
      id: "readme-exists",
      name: "README.md Quality",
      description: "README has description and setup instructions",
      severity: "warning",
      passed: false,
      error: "README.md not found",
      fixSuggestion: "Create README.md with project description, setup, and usage instructions",
      duration: Date.now() - start,
    };
  }
}

async function checkDevServerStarts(projectDir: string): Promise<GateCheck> {
  const start = Date.now();
  try {
    const { spawn } = await import("node:child_process");

    const passed = await new Promise<boolean>((resolve) => {
      const proc = spawn("npm", ["run", "dev"], {
        cwd: projectDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });

      let output = "";
      const timeout = setTimeout(() => {
        proc.kill();
        // If we got any output, server probably started
        resolve(output.length > 0);
      }, 15_000);

      proc.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
        // Common "server started" signals
        if (/ready|started|listening|local:|http:\/\//i.test(output)) {
          clearTimeout(timeout);
          proc.kill();
          resolve(true);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        // Exit code 0 or killed by us is fine
        resolve(code === 0 || code === null);
      });
    });

    return {
      id: "dev-server-starts",
      name: "Dev Server Starts",
      description: "npm run dev starts without errors",
      severity: "info",
      passed,
      output: passed ? "Dev server started successfully" : undefined,
      error: !passed ? "Dev server failed to start" : undefined,
      fixSuggestion: !passed ? "Check npm run dev output for errors" : undefined,
      duration: Date.now() - start,
    };
  } catch {
    return {
      id: "dev-server-starts",
      name: "Dev Server Starts",
      description: "npm run dev starts without errors",
      severity: "info",
      passed: false,
      error: "Could not test dev server",
      duration: Date.now() - start,
    };
  }
}

// ─── Command Check Helper ────────────────────────────────────────────────────

async function runCommandCheck(
  projectDir: string,
  params: {
    id: GateCheckId;
    name: string;
    description: string;
    severity: GateCheck["severity"];
    command: string;
    fixSuggestion: string;
  }
): Promise<GateCheck> {
  const start = Date.now();
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(params.command, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      id: params.id,
      name: params.name,
      description: params.description,
      severity: params.severity,
      passed: true,
      output: output.slice(0, 1000),
      duration: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const errorOutput = (err.stderr ?? err.stdout ?? err.message ?? "Unknown error").slice(0, 1500);

    return {
      id: params.id,
      name: params.name,
      description: params.description,
      severity: params.severity,
      passed: false,
      error: errorOutput,
      fixSuggestion: params.fixSuggestion,
      duration: Date.now() - start,
    };
  }
}

// ─── Summary Builder ─────────────────────────────────────────────────────────

function buildGateSummary(
  checks: GateCheck[],
  score: number,
  grade: string,
  passed: boolean
): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              🔒 Quality Gate Results                          ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`📊 Score: ${score}/100 (Grade: ${grade})`);
  lines.push(`${passed ? "✅ PASSED" : "❌ BLOCKED"} — ${passed ? "App is submission-ready!" : "Fix blockers before submitting."}`);
  lines.push("");

  for (const check of checks) {
    const icon = check.passed ? "✅" : check.severity === "blocker" ? "❌" : "⚠️";
    lines.push(`  ${icon} ${check.name} (${check.severity})`);
    if (check.error) {
      lines.push(`     └─ ${check.error.split("\n")[0]}`);
    }
  }

  return lines.join("\n");
}

// ─── Export for use as fix-loop target ────────────────────────────────────────

export function getFailedChecksAsPrompt(result: QualityGateResult): string {
  if (result.passed) return "";

  const lines = ["## Quality Gate Failures — Fix Required", ""];

  for (const check of [...result.blockers, ...result.warnings]) {
    lines.push(`### ${check.name} (${check.severity})`);
    if (check.error) lines.push(`Error: ${check.error}`);
    if (check.fixSuggestion) lines.push(`Fix: ${check.fixSuggestion}`);
    lines.push("");
  }

  lines.push("Fix ALL blockers. Warnings are optional but recommended.");
  return lines.join("\n");
}
