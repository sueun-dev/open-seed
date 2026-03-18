/**
 * Factcheck Hook — Validate assumptions before execution.
 *
 * Inspired by oh-my-claudecode:
 * - Parse agent messages for factual claims
 * - Quick checks: file existence, package names, command availability
 * - Warn if wrong before cascading errors
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../core/utils.js";

export interface FactClaim {
  type: "file_exists" | "package_installed" | "command_available" | "function_exists" | "import_valid";
  claim: string;
  verified: boolean;
  actual?: string;
}

export interface FactcheckResult {
  claims: FactClaim[];
  allValid: boolean;
  warnings: string[];
}

/**
 * Extract factual claims from an agent's planned actions/text.
 */
export function extractClaims(text: string): Array<{ type: FactClaim["type"]; claim: string }> {
  const claims: Array<{ type: FactClaim["type"]; claim: string }> = [];

  // File paths mentioned
  const filePaths = text.match(/(?:src|lib|tests?|app|config|scripts?)\/[\w/.@-]+\.\w+/g);
  if (filePaths) {
    for (const fp of new Set(filePaths)) {
      claims.push({ type: "file_exists", claim: fp });
    }
  }

  // Package names in import statements or install commands
  const packages = text.match(/(?:from\s+['"]|require\(['"])(@?[\w/-]+)/g);
  if (packages) {
    for (const pkg of packages) {
      const name = pkg.replace(/^(?:from\s+['"]|require\(['"])/, "");
      if (!name.startsWith(".") && !name.startsWith("/")) {
        claims.push({ type: "package_installed", claim: name });
      }
    }
  }

  // Shell commands
  const commands = text.match(/\b(npx|npm|pnpm|yarn|bun|tsc|vitest|jest|pytest|cargo|go)\s+\w+/g);
  if (commands) {
    for (const cmd of new Set(commands)) {
      claims.push({ type: "command_available", claim: cmd.split(/\s+/)[0] });
    }
  }

  return claims;
}

/**
 * Verify claims against the actual project state.
 */
export async function verifyClaims(
  cwd: string,
  claims: Array<{ type: FactClaim["type"]; claim: string }>
): Promise<FactcheckResult> {
  const verified: FactClaim[] = [];
  const warnings: string[] = [];

  for (const claim of claims) {
    switch (claim.type) {
      case "file_exists": {
        const exists = await fileExists(path.resolve(cwd, claim.claim));
        verified.push({ ...claim, verified: exists, actual: exists ? "exists" : "not found" });
        if (!exists) warnings.push(`File "${claim.claim}" does not exist`);
        break;
      }
      case "package_installed": {
        const pkgPath = path.join(cwd, "node_modules", claim.claim);
        const exists = await fileExists(pkgPath);
        verified.push({ ...claim, verified: exists, actual: exists ? "installed" : "not installed" });
        if (!exists) warnings.push(`Package "${claim.claim}" is not installed`);
        break;
      }
      case "command_available": {
        // Check if command is available (node_modules/.bin or global)
        const binPath = path.join(cwd, "node_modules", ".bin", claim.claim);
        const localExists = await fileExists(binPath);
        verified.push({ ...claim, verified: localExists, actual: localExists ? "local" : "check global" });
        break;
      }
      default:
        verified.push({ ...claim, verified: true });
    }
  }

  return {
    claims: verified,
    allValid: warnings.length === 0,
    warnings
  };
}

/**
 * Build a factcheck context string for injection into prompts.
 */
export function buildFactcheckContext(result: FactcheckResult): string {
  if (result.allValid || result.warnings.length === 0) return "";

  return [
    "# Factcheck Warnings",
    "The following assumptions may be incorrect:",
    ...result.warnings.map(w => `- ${w}`),
    "",
    "Adjust your plan accordingly."
  ].join("\n");
}
