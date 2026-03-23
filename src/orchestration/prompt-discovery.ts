/**
 * Prompt Discovery Engine — Requirement extraction from a single prompt.
 *
 * Previously used regex to detect app category and stack layers.
 * Now returns safe defaults and lets AI make all decisions.
 * The types and interfaces are preserved for backward compatibility
 * with create.ts, blueprint.ts, etc.
 */

import type { IntentAnalysis } from "./intent-gate.js";
import { analyzeIntent } from "./intent-gate.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AppCategory =
  | "web-app"
  | "api-server"
  | "cli-tool"
  | "library"
  | "fullstack"
  | "mobile-web"
  | "desktop"
  | "chrome-extension"
  | "vscode-extension"
  | "discord-bot"
  | "slack-bot"
  | "automation"
  | "game"
  | "unknown";

export type StackLayer =
  | "frontend"
  | "backend"
  | "database"
  | "auth"
  | "testing"
  | "deployment"
  | "styling"
  | "state-management"
  | "api-integration"
  | "real-time"
  | "file-storage"
  | "search"
  | "caching"
  | "monitoring"
  | "i18n";

export interface DiscoveryQuestion {
  id: string;
  question: string;
  rationale: string;
  priority: "critical" | "recommended" | "optional";
  suggestion?: string;
  layer: StackLayer | "scope" | "design" | "constraints";
  options?: string[];
}

export interface DiscoveryResult {
  originalPrompt: string;
  inferredGoal: string;
  appCategory: AppCategory;
  detectedLayers: StackLayer[];
  questions: DiscoveryQuestion[];
  assumptions: string[];
  intent: IntentAnalysis;
  complexity: "simple" | "moderate" | "complex" | "enterprise";
  suggestedStack: Record<string, string>;
}

export interface UserAnswer {
  questionId: string;
  answer: string;
  skipped?: boolean;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────

/**
 * Returns a generic discovery result with safe defaults.
 * AI ANALYZE step makes all real decisions (category, layers, stack, complexity).
 * This function is only used by the CLI `create` command for interactive Q&A.
 */
export function discoverRequirements(prompt: string): DiscoveryResult {
  const intent = analyzeIntent(prompt);

  return {
    originalPrompt: prompt,
    inferredGoal: `Build: "${prompt.trim()}"`,
    appCategory: "unknown",
    detectedLayers: ["frontend", "testing"],
    questions: [
      {
        id: "q1",
        question: "이 앱의 핵심 기능을 3가지로 정리하면 뭐가 가장 중요한가요?",
        rationale: "핵심 기능을 명확히 해야 불필요한 기능을 빌드하지 않습니다",
        priority: "critical",
        layer: "scope"
      },
      {
        id: "q2",
        question: "어떤 플랫폼을 원하시나요?",
        rationale: "플랫폼에 따라 기술 스택이 결정됩니다",
        priority: "critical",
        layer: "design",
        options: ["웹 앱", "모바일 웹", "데스크톱", "CLI", "API 서버", "게임"]
      },
      {
        id: "q3",
        question: "특별히 사용하고 싶은 기술이나 피해야 할 기술이 있나요?",
        rationale: "기존 경험이나 프로젝트 요구사항에 맞춰 스택을 조정합니다",
        priority: "optional",
        layer: "constraints",
        suggestion: "없으면 최적의 스택을 자동으로 선택할게요"
      }
    ],
    assumptions: [
      `프로젝트: "${prompt.trim()}"`,
      "AI가 최적의 기술 스택을 자동 선택합니다",
      "프로젝트 구조: 모노리포 (단일 프로젝트)",
      "Git: 자동 초기화"
    ],
    intent,
    complexity: "moderate",
    suggestedStack: {
      "note": "AI ANALYZE 단계에서 최적의 스택을 결정합니다"
    }
  };
}

// ─── Format for Display ──────────────────────────────────────────────────────

export function formatDiscoveryForUser(result: DiscoveryResult): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              프로젝트 분석 결과                              ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`목표: ${result.inferredGoal}`);
  lines.push(`복잡도: ${result.complexity}`);
  lines.push("");

  lines.push("── 자동 감지된 사항 ──────────────────────────────────────────");
  for (const assumption of result.assumptions) {
    lines.push(`  - ${assumption}`);
  }
  lines.push("");

  const critical = result.questions.filter(q => q.priority === "critical");
  const optional = result.questions.filter(q => q.priority !== "critical");

  if (critical.length > 0) {
    lines.push("── 꼭 확인이 필요한 사항 ─────────────────────────────");
    for (const q of critical) {
      lines.push(`  ? ${q.question}`);
      if (q.options) {
        lines.push(`     선택지: ${q.options.join(" | ")}`);
      }
      if (q.suggestion) {
        lines.push(`     추천: ${q.suggestion}`);
      }
    }
    lines.push("");
  }

  if (optional.length > 0) {
    lines.push("── 선택 사항 ──────────────────────────────────────────");
    for (const q of optional) {
      lines.push(`  ? ${q.question}`);
      if (q.suggestion) {
        lines.push(`     추천: ${q.suggestion}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Merge Answers Back into Discovery ───────────────────────────────────────

export function applyAnswers(
  discovery: DiscoveryResult,
  _answers: UserAnswer[]
): DiscoveryResult {
  // No regex-based layer detection. Return discovery as-is.
  // AI ANALYZE step will use the answers in context.
  return { ...discovery };
}
