/**
 * Cline-inspired Rules Engine.
 *
 * Loads rules from .agent/rules.md and config, then evaluates them
 * against tool calls and actions to enforce hard boundaries.
 *
 * Rules can:
 * - Override approval mode for specific tools/files/commands
 * - Block dangerous actions entirely
 * - Auto-approve trusted patterns
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRule, ApprovalMode, ToolCall } from "../core/types.js";
import { fileExists } from "../core/utils.js";

export interface RuleEvaluation {
  matched: boolean;
  ruleId: string | null;
  action: ApprovalMode | "block" | "pass";
  reason: string;
}

export class RulesEngine {
  private rules: AgentRule[] = [];

  constructor(rules: AgentRule[] = []) {
    this.rules = rules.filter((r) => r.enabled);
  }

  /** Load rules from .agent/rules.md in the workspace */
  static async fromWorkspace(cwd: string, configRules: AgentRule[] = []): Promise<RulesEngine> {
    const rules = [...configRules];
    const rulesPath = path.join(cwd, ".agent", "rules.md");

    if (await fileExists(rulesPath)) {
      const content = await fs.readFile(rulesPath, "utf8");
      const parsed = parseRulesMarkdown(content);
      rules.push(...parsed);
    }

    return new RulesEngine(rules);
  }

  /** Evaluate a tool call against all rules */
  evaluate(call: ToolCall, filePath?: string): RuleEvaluation {
    for (const rule of this.rules) {
      if (this.matchesRule(rule, call, filePath)) {
        return {
          matched: true,
          ruleId: rule.id,
          action: rule.approvalOverride ?? "pass",
          reason: rule.description
        };
      }
    }

    return {
      matched: false,
      ruleId: null,
      action: "pass",
      reason: "No rules matched"
    };
  }

  /** Check if a bash command is blocked by rules */
  evaluateCommand(command: string): RuleEvaluation {
    for (const rule of this.rules) {
      if (!rule.commandPatterns?.length) continue;
      for (const pattern of rule.commandPatterns) {
        if (new RegExp(pattern, "i").test(command)) {
          return {
            matched: true,
            ruleId: rule.id,
            action: rule.approvalOverride ?? "pass",
            reason: rule.description
          };
        }
      }
    }

    return { matched: false, ruleId: null, action: "pass", reason: "No command rules matched" };
  }

  getRules(): AgentRule[] {
    return [...this.rules];
  }

  private matchesRule(rule: AgentRule, call: ToolCall, filePath?: string): boolean {
    // A rule must have at least one condition to match.
    // If no conditions match the call, the rule does NOT apply.
    let hasCondition = false;
    let conditionsMet = 0;

    // Check tool name match
    if (rule.toolNames?.length) {
      hasCondition = true;
      if (rule.toolNames.includes(call.name)) conditionsMet++;
      else return false; // tool name doesn't match
    }

    // Check file pattern match
    if (rule.filePatterns?.length) {
      hasCondition = true;
      if (filePath) {
        const matched = rule.filePatterns.some((pattern) => {
          const regex = globToRegex(pattern);
          return regex.test(filePath);
        });
        if (matched) conditionsMet++;
        else return false; // file pattern doesn't match
      }
      // No filePath provided — this condition is not evaluable, skip it
    }

    // Check command pattern match (only for bash/git tools)
    if (rule.commandPatterns?.length) {
      hasCondition = true;
      if (call.name === "bash" || call.name === "git") {
        const command = typeof call.input.command === "string" ? call.input.command
          : Array.isArray(call.input.args) ? (call.input.args as string[]).join(" ") : "";
        const matched = rule.commandPatterns.some((pattern) =>
          new RegExp(pattern, "i").test(command)
        );
        if (matched) conditionsMet++;
        else return false; // command pattern doesn't match
      } else {
        // Rule has commandPatterns but this tool is not bash/git — rule doesn't apply
        return false;
      }
    }

    // Rule only matches if it has at least one condition and all conditions were met
    return hasCondition && conditionsMet > 0;
  }
}

/**
 * Parse rules from markdown format:
 *
 * ## rule-id: Description
 * - tools: write, bash
 * - files: *.env, secrets/**
 * - commands: rm -rf, DROP TABLE
 * - action: block
 */
function parseRulesMarkdown(content: string): AgentRule[] {
  const rules: AgentRule[] = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0];
    if (!header) continue;

    const colonIdx = header.indexOf(":");
    const id = colonIdx > 0 ? header.slice(0, colonIdx).trim() : header.trim();
    const description = colonIdx > 0 ? header.slice(colonIdx + 1).trim() : "";

    const rule: AgentRule = { id, description, enabled: true };

    for (const line of lines.slice(1)) {
      const trimmed = line.replace(/^-\s*/, "").trim();
      if (trimmed.startsWith("tools:")) {
        rule.toolNames = trimmed.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (trimmed.startsWith("files:")) {
        rule.filePatterns = trimmed.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (trimmed.startsWith("commands:")) {
        rule.commandPatterns = trimmed.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (trimmed.startsWith("action:")) {
        const action = trimmed.slice(7).trim() as ApprovalMode | "block";
        if (["ask", "auto", "block"].includes(action)) {
          rule.approvalOverride = action;
        }
      }
    }

    rules.push(rule);
  }

  return rules;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}
