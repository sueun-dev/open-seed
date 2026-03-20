import type {
  ExecutorArtifact,
  PlannerArtifact,
  PlannerTask,
  ProviderAdapter,
  ProviderConfig,
  ProviderInvokeOptions,
  ProviderRequest,
  ProviderResponse,
  ResearchArtifact,
  ReviewResult,
  ToolCall
} from "../core/types.js";
import { createMockSpecialistArtifact } from "../orchestration/contracts.js";
import { emitTextInChunks } from "./shared.js";

function makePlannerArtifact(request: ProviderRequest): PlannerArtifact {
  const taskText = extractTaskText(request.prompt);
  const tasks = inferPlannerTasks(taskText);
  return {
    summary: `Planned task for ${request.role}`,
    tasks
  };
}

function makeExecutorArtifact(request: ProviderRequest): ExecutorArtifact {
  // If prompt contains tool results from a previous turn, the task is done —
  // return empty toolCalls so the agentic loop can terminate.
  if (/Tool results:/i.test(request.prompt) || /\[assistant\]:/i.test(request.prompt)) {
    return createMockSpecialistArtifact({
      roleId: "executor",
      category: "execution",
      prompt: request.prompt,
      toolCalls: []
    }) as ExecutorArtifact;
  }

  const calls = buildToolCalls(request);
  // First turn: ensure at least one tool call so the executor validation passes
  if (calls.length === 0) {
    calls.push({ name: "repo_map", reason: "Inspect repository structure", input: {} });
  }
  return createMockSpecialistArtifact({
    roleId: "executor",
    category: "execution",
    prompt: request.prompt,
    toolCalls: calls
  }) as ExecutorArtifact;
}

function makeResearchArtifact(request: ProviderRequest): ResearchArtifact {
  return {
    summary: `Research summary for ${request.prompt.slice(0, 48)}`,
    findings: [
      "Root AGENTS.md should be included before task prompt",
      "Repo map should prioritize likely source files"
    ],
    risks: [
      "Provider API keys might be absent; mock fallback remains active"
    ]
  };
}

function makeSpecialistArtifact(request: ProviderRequest): unknown {
  return createMockSpecialistArtifact({
    roleId: request.role,
    category: request.category,
    prompt: request.prompt,
    toolCalls: request.category === "execution" || request.category === "frontend"
      ? buildToolCalls(request)
      : []
  });
}

function makeReviewResult(request: ProviderRequest): ReviewResult {
  if (/"approved":\s*false/.test(request.prompt) || /"ok":\s*false/.test(request.prompt)) {
    return {
      verdict: "fail",
      summary: "Execution contains blocked or failed tool calls.",
      followUp: [
        "Resolve blocked approvals or adjust the execution plan to use permitted tools.",
        "Re-run verification after the tool failures are addressed."
      ]
    };
  }
  return {
    verdict: "pass",
    summary: "Outputs are internally consistent for the MVP workflow.",
    followUp: []
  };
}

function buildToolCalls(request: ProviderRequest): ToolCall[] {
  const calls: ToolCall[] = [];
  const taskScope = extractExecutionScope(request.prompt);
  const workspaceFile = pickWorkspaceFile(request.prompt);
  const valueUpdate = taskScope.match(/value\s*(?:to|=)\s*(\d+)/i);

  if (workspaceFile && valueUpdate) {
    calls.push({
      name: "read",
      reason: "Inspect the target file before editing it.",
      input: {
        path: workspaceFile,
        withHashes: false
      }
    });
    calls.push({
      name: "write",
      reason: "Update the exported value to match the requested change.",
      input: {
        path: workspaceFile,
        content: `export const value = ${valueUpdate[1]};\n`
      }
    });
  }

  if (/\bnpm test\b|\bpnpm test\b|\byarn test\b|\brun tests?\b|\bexecute tests?\b|\bverify with npm test\b/i.test(taskScope)) {
    calls.push({
      name: "bash",
      reason: "Run the project test suite to verify the requested change.",
      input: {
        command: "npm test",
        timeoutMs: 30_000,
        dryRun: true
      }
    });
  }

  if (/\bnpm run build\b|\bpnpm build\b|\byarn build\b|\btypecheck\b|\btsc\b/i.test(taskScope)) {
    calls.push({
      name: "bash",
      reason: "Run the project build or typecheck command safely.",
      input: {
        command: /\btsc\b/i.test(request.prompt) ? "tsc --noEmit" : "npm run build",
        timeoutMs: 30_000,
        dryRun: true
      }
    });
  }

  if (/diagnostic|typecheck|symbol/i.test(taskScope) && workspaceFile) {
    calls.push({
      name: "lsp_symbols",
      reason: "Inspect the TypeScript symbols in the target file.",
      input: {
        path: workspaceFile
      }
    });
  }

  if (/status|repo map|search/i.test(taskScope) && calls.length === 0) {
    calls.push({
      name: "repo_map",
      reason: "Inspect the repository structure before changing anything.",
      input: {}
    });
  }

  return calls;
}

function inferPlannerTasks(prompt: string): PlannerTask[] {
  const tasks: PlannerTask[] = [
    {
      id: "inspect",
      title: `Inspect relevant files for: ${prompt.slice(0, 60)}`,
      category: "research",
      roleHint: /oauth|auth|token|security/i.test(prompt) ? "security-auditor" : undefined
    }
  ];

  if (/\b(frontend|ui|ux|layout|visual|browser|css|component)\b/i.test(prompt)) {
    tasks.push({
      id: "frontend",
      title: "Implement the requested frontend or browser-facing change",
      category: "frontend",
      roleHint: /browser|screenshot|dom|console|network/i.test(prompt) ? "browser-operator" : "frontend-engineer"
    });
  } else if (/build|typecheck|compile|tsc/i.test(prompt)) {
    tasks.push({
      id: "build",
      title: "Unblock the build and typecheck path",
      category: "execution",
      roleHint: "build-doctor"
    });
  } else if (/debug|root cause|trace|failure|broken/i.test(prompt)) {
    tasks.push({
      id: "debug",
      title: "Debug the failure and isolate the root cause",
      category: "execution",
      roleHint: "debugger"
    });
  } else {
    tasks.push({
      id: "implement",
      title: "Implement the required change safely",
      category: "execution"
    });
  }

  if (/test|verify|assert|regression/i.test(prompt)) {
    tasks.push({
      id: "tests",
      title: "Add verification coverage and run the relevant tests",
      category: "execution",
      roleHint: "test-engineer"
    });
  }

  if (/docs|readme|guide|document/i.test(prompt)) {
    tasks.push({
      id: "docs",
      title: "Update the docs and summarize the user-facing behavior",
      category: "planning",
      roleHint: "docs-writer"
    });
  }

  tasks.push({
    id: "verify",
    title: "Verify outputs and summarize the result",
    category: "review"
  });

  return tasks;
}

function extractTaskText(prompt: string): string {
  return prompt.match(/^Task:\s*(.+)$/m)?.[1] ?? prompt;
}

function extractExecutionScope(prompt: string): string {
  return prompt.match(/^Delegated specialist task:\s*(.+)$/m)?.[1]
    ?? prompt.match(/^Task:\s*(.+)$/m)?.[1]
    ?? prompt.match(/^Root task:\s*(.+)$/m)?.[1]
    ?? prompt;
}

function pickWorkspaceFile(prompt: string): string | undefined {
  const taskLine = prompt.match(/^Task:\s*(.+)$/m)?.[1];
  const explicitFromTask = taskLine?.match(/\b([\w./-]+\.(?:ts|tsx|js|jsx|json|md))\b/);
  if (explicitFromTask?.[1]) {
    return explicitFromTask[1];
  }
  const explicit = prompt.match(/\b([\w./-]+\.(?:ts|tsx|js|jsx|json|md))\b/);
  if (explicit?.[1]) {
    return explicit[1];
  }
  const match = prompt.match(/^\s*([^\s]+?\.(?:ts|tsx|js|jsx|json|md)) \[/m);
  return match?.[1];
}

export class MockProviderAdapter implements ProviderAdapter {
  readonly id = "mock";

  isConfigured(_config: ProviderConfig | undefined): boolean {
    return true;
  }

  async invoke(_config: ProviderConfig | undefined, request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse> {
    let text: string;
    switch (request.role) {
      case "planner":
        text = JSON.stringify(makePlannerArtifact(request), null, 2);
        break;
      case "researcher":
        text = JSON.stringify(makeResearchArtifact(request), null, 2);
        break;
      case "reviewer":
        text = JSON.stringify(makeReviewResult(request), null, 2);
        break;
      case "executor":
      case "frontend-engineer":
        text = JSON.stringify(makeExecutorArtifact(request), null, 2);
        break;
      default:
        text = JSON.stringify(makeSpecialistArtifact(request), null, 2);
        break;
    }
    await emitTextInChunks(text, options?.onTextDelta);
    return {
      provider: "mock",
      model: "mock-local",
      text,
      metadata: {
        streamed: Boolean(options?.onTextDelta)
      }
    };
  }
}
