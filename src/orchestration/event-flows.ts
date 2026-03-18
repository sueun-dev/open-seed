/**
 * Event-Driven Flows — conditional agent routing based on runtime events.
 * From CrewAI Flows: more expressive than static task DAGs.
 *
 * Agents respond to runtime events:
 * - Agent A finishes → triggers Agent B (only if condition X is met)
 * - Error occurs → route to debugger agent
 * - Test fails → route to test-engineer
 * - Build fails → route to build-doctor
 */

export type FlowCondition = (event: FlowEvent) => boolean;

export interface FlowEvent {
  type: string;
  source: string;
  data: Record<string, unknown>;
}

export interface FlowRule {
  id: string;
  /** What event triggers this rule */
  trigger: string;
  /** Optional condition — rule only fires if this returns true */
  condition?: FlowCondition;
  /** What role to activate */
  targetRole: string;
  /** Prompt to send to the target */
  promptTemplate: string;
  /** Priority (higher = evaluated first) */
  priority: number;
}

export class FlowEngine {
  private rules: FlowRule[] = [];

  addRule(rule: FlowRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter(r => r.id !== id);
  }

  /**
   * Evaluate an event against all rules and return matching actions.
   */
  evaluate(event: FlowEvent): Array<{ rule: FlowRule; prompt: string }> {
    const matches: Array<{ rule: FlowRule; prompt: string }> = [];

    for (const rule of this.rules) {
      if (rule.trigger !== event.type && rule.trigger !== "*") continue;
      if (rule.condition && !rule.condition(event)) continue;

      const prompt = rule.promptTemplate
        .replace(/\{\{type\}\}/g, event.type)
        .replace(/\{\{source\}\}/g, event.source)
        .replace(/\{\{data\}\}/g, JSON.stringify(event.data));

      matches.push({ rule, prompt });
    }

    return matches;
  }
}

/**
 * Create default flow rules that handle common scenarios.
 */
export function createDefaultFlows(): FlowEngine {
  const engine = new FlowEngine();

  // Test failure → test-engineer
  engine.addRule({
    id: "test-fail-to-engineer",
    trigger: "tool.completed",
    condition: (e) => e.data.tool === "bash" && e.data.ok === false &&
      /test|jest|vitest|pytest/i.test(String(e.data.command ?? "")),
    targetRole: "test-engineer",
    promptTemplate: "Test command failed: {{data}}. Analyze the failure and fix the test or the code.",
    priority: 10
  });

  // Build failure → build-doctor
  engine.addRule({
    id: "build-fail-to-doctor",
    trigger: "tool.completed",
    condition: (e) => e.data.tool === "bash" && e.data.ok === false &&
      /build|tsc|webpack|vite/i.test(String(e.data.command ?? "")),
    targetRole: "build-doctor",
    promptTemplate: "Build failed: {{data}}. Diagnose and fix the build error.",
    priority: 10
  });

  // Type error → executor
  engine.addRule({
    id: "type-error-fix",
    trigger: "tool.completed",
    condition: (e) => e.data.tool === "lsp_diagnostics" && e.data.ok === true &&
      Array.isArray(e.data.diagnostics) && (e.data.diagnostics as unknown[]).length > 0,
    targetRole: "executor",
    promptTemplate: "TypeScript diagnostics found errors: {{data}}. Fix all type errors.",
    priority: 8
  });

  // Security issue detected → security-auditor
  engine.addRule({
    id: "security-review",
    trigger: "tool.completed",
    condition: (e) => e.data.tool === "write" && e.data.ok === true &&
      /auth|login|password|token|secret|credential/i.test(String(e.data.path ?? "")),
    targetRole: "security-auditor",
    promptTemplate: "Security-sensitive file was modified: {{data}}. Review for vulnerabilities.",
    priority: 5
  });

  return engine;
}
