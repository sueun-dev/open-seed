/**
 * Prompt Discovery Engine — Intelligent requirement extraction from a single prompt.
 *
 * Takes a vague user prompt like "Todo 앱 만들어줘" and generates intelligent
 * clarifying questions so the AI can build a complete, submission-ready app.
 *
 * Inspired by:
 * - oh-my-openagent: intent verbalization + Sisyphus assessment
 * - Devin: autonomous planning with user confirmation
 * - Cursor: inline requirement discovery
 * - Claude Code: structured task breakdown
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
  /** Why this question matters for the build */
  rationale: string;
  /** Priority: critical questions block the build, optional are suggestions */
  priority: "critical" | "recommended" | "optional";
  /** Pre-filled suggestion based on analysis */
  suggestion?: string;
  /** Category this question maps to */
  layer: StackLayer | "scope" | "design" | "constraints";
  /** Possible answers for structured selection */
  options?: string[];
}

export interface DiscoveryResult {
  /** Original user prompt */
  originalPrompt: string;
  /** What we think the user wants */
  inferredGoal: string;
  /** Detected app category */
  appCategory: AppCategory;
  /** Which stack layers are likely needed */
  detectedLayers: StackLayer[];
  /** Intelligent questions to ask the user */
  questions: DiscoveryQuestion[];
  /** What we can already determine without asking */
  assumptions: string[];
  /** Intent analysis from the existing system */
  intent: IntentAnalysis;
  /** Estimated complexity */
  complexity: "simple" | "moderate" | "complex" | "enterprise";
  /** Suggested tech stack based on analysis */
  suggestedStack: Record<string, string>;
}

export interface UserAnswer {
  questionId: string;
  answer: string;
  /** User chose to skip this question (use defaults) */
  skipped?: boolean;
}

// ─── Category Detection ──────────────────────────────────────────────────────

interface CategoryRule {
  category: AppCategory;
  patterns: RegExp[];
  defaultLayers: StackLayer[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "fullstack",
    patterns: [/\b(fullstack|full.stack|앱|어플|application|saas|platform|marketplace|dashboard)\b/i],
    defaultLayers: ["frontend", "backend", "database", "auth", "testing", "styling"]
  },
  {
    category: "web-app",
    patterns: [/\b(web\s*app|website|웹|사이트|landing|portfolio|blog|wiki|forum)\b/i],
    defaultLayers: ["frontend", "styling", "testing"]
  },
  {
    category: "api-server",
    patterns: [/\b(api|server|backend|서버|rest|graphql|microservice)\b/i],
    defaultLayers: ["backend", "database", "testing", "api-integration"]
  },
  {
    category: "cli-tool",
    patterns: [/\b(cli|command.line|terminal|tool|유틸|utility|script)\b/i],
    defaultLayers: ["testing"]
  },
  {
    category: "library",
    patterns: [/\b(library|package|module|sdk|라이브러리|패키지|npm)\b/i],
    defaultLayers: ["testing"]
  },
  {
    category: "chrome-extension",
    patterns: [/\b(chrome\s*ext|browser\s*ext|확장\s*프로그램)\b/i],
    defaultLayers: ["frontend", "styling", "testing"]
  },
  {
    category: "vscode-extension",
    patterns: [/\b(vscode\s*ext|vs\s*code\s*ext)\b/i],
    defaultLayers: ["testing"]
  },
  {
    category: "discord-bot",
    patterns: [/\b(discord\s*bot|디스코드\s*봇)\b/i],
    defaultLayers: ["backend", "database", "api-integration"]
  },
  {
    category: "slack-bot",
    patterns: [/\b(slack\s*bot|슬랙\s*봇)\b/i],
    defaultLayers: ["backend", "database", "api-integration"]
  },
  {
    category: "mobile-web",
    patterns: [/\b(mobile|모바일|responsive|pwa|react\s*native)\b/i],
    defaultLayers: ["frontend", "backend", "styling", "testing"]
  },
  {
    category: "automation",
    patterns: [/\b(automat|자동화|scrape|crawl|bot|cron|schedule|workflow)\b/i],
    defaultLayers: ["backend", "testing"]
  },
  {
    category: "game",
    patterns: [/(game|게임|snake|tetris|platformer|shooter|arcade|puzzle|canvas\s*game|스네이크|테트리스|벽돌깨기)/i],
    defaultLayers: ["frontend", "testing"]
  },
];

// ─── Layer Detection ─────────────────────────────────────────────────────────

interface LayerRule {
  layer: StackLayer;
  patterns: RegExp[];
}

const LAYER_RULES: LayerRule[] = [
  { layer: "auth", patterns: [/\b(auth|login|signup|sign.up|register|oauth|jwt|session|user\s*account|회원|로그인|가입)\b/i] },
  { layer: "database", patterns: [/\b(database|db|sql|mongo|postgres|mysql|sqlite|supabase|firebase|store|저장|데이터)\b/i] },
  { layer: "real-time", patterns: [/\b(real.time|websocket|socket|chat|live|notification|push|실시간|채팅|알림)\b/i] },
  { layer: "file-storage", patterns: [/\b(upload|file|image|storage|s3|blob|media|사진|파일|업로드)\b/i] },
  { layer: "search", patterns: [/\b(search|filter|sort|검색|필터|정렬)\b/i] },
  { layer: "api-integration", patterns: [/\b(api|external|third.party|integration|webhook|stripe|paypal|결제|외부)\b/i] },
  { layer: "i18n", patterns: [/\b(i18n|internationali[sz]|multi.lang|translate|번역|다국어)\b/i] },
  { layer: "caching", patterns: [/\b(cache|redis|memcache|캐시)\b/i] },
  { layer: "monitoring", patterns: [/\b(monitor|logging|analytics|sentry|track|모니터링|분석)\b/i] },
  { layer: "state-management", patterns: [/\b(state|redux|zustand|recoil|jotai|context|상태\s*관리)\b/i] },
  { layer: "deployment", patterns: [/\b(deploy|docker|k8s|vercel|netlify|aws|gcp|azure|배포|호스팅)\b/i] },
  { layer: "styling", patterns: [/\b(css|style|tailwind|sass|styled|ui|design|디자인|스타일|예쁘)\b/i] },
];

// ─── Complexity Estimation ───────────────────────────────────────────────────

function estimateComplexity(
  category: AppCategory,
  layers: StackLayer[],
  taskLength: number
): "simple" | "moderate" | "complex" | "enterprise" {
  const layerCount = layers.length;
  const hasAuth = layers.includes("auth");
  const hasRealTime = layers.includes("real-time");
  const hasDB = layers.includes("database");

  if (layerCount <= 2 && !hasAuth && !hasDB) return "simple";
  if (layerCount <= 4 && !hasRealTime) return "moderate";
  if (layerCount <= 6 || (hasAuth && hasDB && !hasRealTime)) return "complex";
  return "enterprise";
}

// ─── Tech Stack Suggestion ───────────────────────────────────────────────────

function suggestStack(category: AppCategory, layers: StackLayer[]): Record<string, string> {
  const stack: Record<string, string> = {};

  // Game category — minimal stack, no frameworks
  if (category === "game") {
    stack["runtime"] = "Browser (no server)";
    stack["language"] = "Vanilla JavaScript (ES2022+)";
    stack["frontend"] = "HTML5 Canvas";
    stack["testing"] = "Playwright (browser E2E)";
    return stack;
  }

  // Runtime
  stack["runtime"] = "Node.js 22+";
  stack["language"] = "TypeScript 5.x";

  // Frontend
  if (layers.includes("frontend")) {
    if (category === "fullstack" || category === "web-app" || category === "mobile-web") {
      stack["frontend"] = "Next.js 15 (App Router)";
      stack["styling"] = "Tailwind CSS 4";
      stack["ui-components"] = "shadcn/ui";
    } else if (category === "chrome-extension") {
      stack["frontend"] = "React + Vite";
    }
  }

  // Backend
  if (layers.includes("backend")) {
    if (category === "fullstack") {
      stack["backend"] = "Next.js API Routes / Server Actions";
    } else {
      stack["backend"] = "Hono (lightweight, fast)";
    }
  }

  // Database
  if (layers.includes("database")) {
    stack["database"] = "SQLite (local) / PostgreSQL (production)";
    stack["orm"] = "Drizzle ORM";
  }

  // Auth
  if (layers.includes("auth")) {
    stack["auth"] = "NextAuth.js v5 / Lucia Auth";
  }

  // Testing
  stack["testing"] = "Vitest + Playwright (E2E)";

  // Package manager
  stack["package-manager"] = "pnpm";

  return stack;
}

// ─── Question Generation ─────────────────────────────────────────────────────

function generateQuestions(
  category: AppCategory,
  layers: StackLayer[],
  complexity: "simple" | "moderate" | "complex" | "enterprise",
  prompt: string
): DiscoveryQuestion[] {
  const questions: DiscoveryQuestion[] = [];
  let qIndex = 0;

  const q = (
    question: string,
    rationale: string,
    priority: DiscoveryQuestion["priority"],
    layer: DiscoveryQuestion["layer"],
    suggestion?: string,
    options?: string[]
  ): void => {
    questions.push({
      id: `q${++qIndex}`,
      question,
      rationale,
      priority,
      layer,
      suggestion,
      options
    });
  };

  // ── Scope questions (always asked for non-trivial) ─────────────────────

  if (complexity !== "simple") {
    q(
      "이 앱의 핵심 기능을 3가지로 정리하면 뭐가 가장 중요한가요?",
      "핵심 기능을 명확히 해야 불필요한 기능을 빌드하지 않습니다",
      "critical",
      "scope"
    );
  }

  // ── Auth questions ─────────────────────────────────────────────────────

  if (!layers.includes("auth") && (category === "fullstack" || category === "web-app")) {
    q(
      "사용자 인증(로그인/회원가입)이 필요한가요?",
      "인증은 DB 스키마, API 구조, 보안 전략에 영향을 줍니다",
      "recommended",
      "auth",
      "이메일/비밀번호 + OAuth (Google) 추천",
      ["필요없음", "이메일/비밀번호만", "OAuth만 (Google/GitHub)", "이메일 + OAuth", "매직링크"]
    );
  }

  if (layers.includes("auth")) {
    q(
      "어떤 인증 방식을 원하시나요?",
      "인증 방식에 따라 전체 보안 아키텍처가 달라집니다",
      "critical",
      "auth",
      "이메일/비밀번호 + Google OAuth",
      ["이메일/비밀번호만", "OAuth만 (Google/GitHub)", "이메일 + OAuth", "매직링크"]
    );
  }

  // ── Database questions ─────────────────────────────────────────────────

  if (layers.includes("database") || category === "fullstack") {
    q(
      "어떤 데이터를 저장해야 하나요? (주요 엔티티를 알려주세요)",
      "DB 스키마 설계는 앱 전체 구조의 기반입니다",
      "critical",
      "database",
      "자동으로 분석해서 스키마를 설계할게요"
    );
  }

  // ── Frontend/Design questions ──────────────────────────────────────────

  if (layers.includes("frontend") || layers.includes("styling")) {
    q(
      "디자인 스타일 선호가 있나요?",
      "UI 컴포넌트 선택과 전체 룩앤필에 영향",
      "recommended",
      "design",
      "모던 미니멀 (shadcn/ui 스타일)",
      ["모던 미니멀", "글래스모피즘", "뉴모피즘", "머터리얼 디자인", "감성적/아기자기", "다크 테마 위주", "참고할 사이트가 있음"]
    );

    q(
      "다크모드 지원이 필요한가요?",
      "처음부터 다크모드를 고려해야 CSS 구조가 깔끔합니다",
      "optional",
      "styling",
      "라이트 + 다크 모드 둘 다 지원 추천",
      ["라이트만", "다크만", "둘 다 (시스템 설정 따라감)", "필요없음"]
    );

    q(
      "모바일 반응형이 필요한가요?",
      "반응형 레이아웃은 처음부터 설계해야 합니다",
      "recommended",
      "styling",
      "모바일 퍼스트 반응형 추천",
      ["데스크톱만", "모바일 퍼스트 반응형", "모바일 전용", "필요없음"]
    );
  }

  // ── API/Integration questions ──────────────────────────────────────────

  if (layers.includes("api-integration")) {
    q(
      "연동해야 하는 외부 API나 서비스가 있나요?",
      "외부 API 연동은 에러 핸들링, 인증, rate limiting 전략이 필요합니다",
      "critical",
      "api-integration"
    );
  }

  // ── Real-time questions ────────────────────────────────────────────────

  if (layers.includes("real-time")) {
    q(
      "실시간 기능이 어디에 필요한가요?",
      "WebSocket vs SSE vs Polling 선택에 영향",
      "critical",
      "real-time",
      undefined,
      ["채팅", "알림", "실시간 협업 편집", "라이브 대시보드", "기타"]
    );
  }

  // ── Deployment questions ───────────────────────────────────────────────

  q(
    "배포 환경은 어디를 생각하시나요?",
    "배포 환경에 맞춰 빌드 설정, 환경변수, CI/CD를 구성합니다",
    "optional",
    "deployment",
    "Vercel (프론트엔드) + Railway/Fly.io (백엔드) 추천",
    ["Vercel", "Netlify", "AWS", "GCP", "Railway", "Fly.io", "Docker (셀프호스팅)", "아직 모르겠음"]
  );

  // ── Testing questions ──────────────────────────────────────────────────

  if (complexity === "complex" || complexity === "enterprise") {
    q(
      "테스트 수준은 어떻게 원하시나요?",
      "테스트 전략에 따라 개발 시간과 안정성이 달라집니다",
      "recommended",
      "testing",
      "유닛 + 통합 테스트 추천 (E2E는 핵심 플로우만)",
      ["유닛 테스트만", "유닛 + 통합", "유닛 + 통합 + E2E", "E2E만", "기본만 (빌드 통과)"]
    );
  }

  // ── Constraints ────────────────────────────────────────────────────────

  q(
    "특별히 사용하고 싶은 기술이나 피해야 할 기술이 있나요?",
    "기존 경험이나 프로젝트 요구사항에 맞춰 스택을 조정합니다",
    "optional",
    "constraints",
    "없으면 최적의 스택을 자동으로 선택할게요"
  );

  return questions;
}

// ─── Assumption Extraction ───────────────────────────────────────────────────

function extractAssumptions(
  prompt: string,
  category: AppCategory,
  layers: StackLayer[],
  stack: Record<string, string>
): string[] {
  const assumptions: string[] = [];

  assumptions.push(`앱 유형: ${category}`);
  assumptions.push(`기본 언어: ${stack["language"]}`);

  if (stack["frontend"]) {
    assumptions.push(`프론트엔드: ${stack["frontend"]}`);
  }
  if (stack["backend"]) {
    assumptions.push(`백엔드: ${stack["backend"]}`);
  }
  if (stack["database"]) {
    assumptions.push(`데이터베이스: ${stack["database"]}`);
  }
  if (stack["testing"]) {
    assumptions.push(`테스팅: ${stack["testing"]}`);
  }

  // Smart assumptions from prompt content
  if (/crud|게시판|board/i.test(prompt)) {
    assumptions.push("CRUD 기반 앱 — Create, Read, Update, Delete 전체 구현");
  }
  if (/todo|할일|task/i.test(prompt)) {
    assumptions.push("할일 관리 — 생성, 완료, 삭제, 필터링 포함");
  }
  if (/shop|store|상점|쇼핑|commerce/i.test(prompt)) {
    assumptions.push("이커머스 — 상품 목록, 장바구니, 결제 플로우 포함");
  }
  if (/blog|블로그/i.test(prompt)) {
    assumptions.push("블로그 — 글 작성, 목록, 상세보기, 마크다운 지원");
  }
  if (/chat|채팅/i.test(prompt)) {
    assumptions.push("채팅 — 실시간 메시징, 채팅방, 메시지 히스토리 포함");
  }

  assumptions.push("프로젝트 구조: 모노리포 (단일 프로젝트)");
  assumptions.push("코드 스타일: ESLint + Prettier 자동 설정");
  assumptions.push("Git: 자동 초기화 + 의미있는 커밋 메시지");

  return assumptions;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────

export function discoverRequirements(prompt: string): DiscoveryResult {
  const intent = analyzeIntent(prompt);

  // Detect app category
  let appCategory: AppCategory = "unknown";
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some(p => p.test(prompt))) {
      appCategory = rule.category;
      break;
    }
  }

  // If we still don't know, infer from intent
  if (appCategory === "unknown") {
    if (intent.action === "build" || intent.action === "add") {
      // Default to fullstack for "make me an app" type prompts
      appCategory = "fullstack";
    } else {
      appCategory = "web-app";
    }
  }

  // Detect layers from prompt + category defaults
  const detectedLayers = new Set<StackLayer>();
  const categoryRule = CATEGORY_RULES.find(r => r.category === appCategory);
  if (categoryRule) {
    for (const layer of categoryRule.defaultLayers) {
      detectedLayers.add(layer);
    }
  }
  for (const rule of LAYER_RULES) {
    if (rule.patterns.some(p => p.test(prompt))) {
      detectedLayers.add(rule.layer);
    }
  }

  const layers = Array.from(detectedLayers);
  const complexity = estimateComplexity(appCategory, layers, prompt.length);
  const suggestedStack = suggestStack(appCategory, layers);

  // Infer goal from prompt
  const inferredGoal = inferGoal(prompt, appCategory, layers);

  const questions = generateQuestions(appCategory, layers, complexity, prompt);
  const assumptions = extractAssumptions(prompt, appCategory, layers, suggestedStack);

  return {
    originalPrompt: prompt,
    inferredGoal,
    appCategory,
    detectedLayers: layers,
    questions,
    assumptions,
    intent,
    complexity,
    suggestedStack
  };
}

function inferGoal(prompt: string, category: AppCategory, layers: StackLayer[]): string {
  // Remove common filler words
  const cleaned = prompt
    .replace(/\b(만들어줘|만들어|만들|해줘|해주세요|해주|please|create|build|make)\b/gi, "")
    .replace(/\b(나|나를|위한|위해|for me|나한테)\b/gi, "")
    .trim();

  if (!cleaned || cleaned.length < 3) {
    return `${category} 애플리케이션을 처음부터 완전하게 빌드`;
  }

  return `"${cleaned}" — ${category} 애플리케이션으로 완전하게 빌드 (${layers.length}개 스택 레이어 포함)`;
}

// ─── Format for Display ──────────────────────────────────────────────────────

export function formatDiscoveryForUser(result: DiscoveryResult): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              🔍 프로젝트 분석 결과                            ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`📋 목표: ${result.inferredGoal}`);
  lines.push(`📦 유형: ${result.appCategory} | 복잡도: ${result.complexity}`);
  lines.push("");

  lines.push("── 자동 감지된 사항 ──────────────────────────────────────────");
  for (const assumption of result.assumptions) {
    lines.push(`  ✓ ${assumption}`);
  }
  lines.push("");

  lines.push("── 추천 기술 스택 ──────────────────────────────────────────");
  for (const [key, value] of Object.entries(result.suggestedStack)) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push("");

  const critical = result.questions.filter(q => q.priority === "critical");
  const recommended = result.questions.filter(q => q.priority === "recommended");
  const optional = result.questions.filter(q => q.priority === "optional");

  if (critical.length > 0) {
    lines.push("── 꼭 확인이 필요한 사항 (필수) ─────────────────────────────");
    for (const q of critical) {
      lines.push(`  ❓ ${q.question}`);
      if (q.options) {
        lines.push(`     → 선택지: ${q.options.join(" | ")}`);
      }
      if (q.suggestion) {
        lines.push(`     💡 추천: ${q.suggestion}`);
      }
    }
    lines.push("");
  }

  if (recommended.length > 0) {
    lines.push("── 추천 확인 사항 ──────────────────────────────────────────");
    for (const q of recommended) {
      lines.push(`  ❓ ${q.question}`);
      if (q.options) {
        lines.push(`     → 선택지: ${q.options.join(" | ")}`);
      }
      if (q.suggestion) {
        lines.push(`     💡 추천: ${q.suggestion}`);
      }
    }
    lines.push("");
  }

  if (optional.length > 0) {
    lines.push("── 선택 사항 (기본값으로 진행 가능) ──────────────────────────");
    for (const q of optional) {
      lines.push(`  ❓ ${q.question}`);
      if (q.suggestion) {
        lines.push(`     💡 추천: ${q.suggestion}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Merge Answers Back into Discovery ───────────────────────────────────────

export function applyAnswers(
  discovery: DiscoveryResult,
  answers: UserAnswer[]
): DiscoveryResult {
  const updated = { ...discovery, detectedLayers: [...discovery.detectedLayers] };
  const answerMap = new Map(answers.map(a => [a.questionId, a]));

  for (const question of discovery.questions) {
    const answer = answerMap.get(question.id);
    if (!answer || answer.skipped) continue;

    const lower = answer.answer.toLowerCase();

    // Update layers based on answers
    if (question.layer === "auth") {
      if (lower.includes("필요없음") || lower === "no") {
        updated.detectedLayers = updated.detectedLayers.filter(l => l !== "auth");
      } else {
        if (!updated.detectedLayers.includes("auth")) {
          updated.detectedLayers.push("auth");
        }
      }
    }

    if (question.layer === "real-time") {
      if (!updated.detectedLayers.includes("real-time")) {
        updated.detectedLayers.push("real-time");
      }
    }

    if (question.layer === "database") {
      if (!updated.detectedLayers.includes("database")) {
        updated.detectedLayers.push("database");
      }
    }
  }

  // Recalculate complexity and stack
  updated.complexity = estimateComplexity(
    updated.appCategory,
    updated.detectedLayers,
    updated.originalPrompt.length
  );
  updated.suggestedStack = suggestStack(updated.appCategory, updated.detectedLayers);

  return updated;
}
