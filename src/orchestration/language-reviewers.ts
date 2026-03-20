/**
 * Multi-Language Reviewers — language-specific code review with build-error resolution.
 *
 * Each language has specialized review rules, common error patterns, and fix strategies.
 * Source: everything-claude-code — language-specific reviewer agents
 */

export interface LanguageReviewRule {
  id: string;
  language: string;
  pattern: RegExp;
  severity: "error" | "warning" | "info";
  message: string;
  fix?: string;
}

export interface LanguageReviewer {
  language: string;
  extensions: string[];
  buildCommand: string;
  testCommand: string;
  lintCommand: string;
  rules: LanguageReviewRule[];
  commonErrors: Array<{ pattern: RegExp; fix: string }>;
  bestPractices: string[];
}

export const LANGUAGE_REVIEWERS: Record<string, LanguageReviewer> = {
  typescript: {
    language: "TypeScript",
    extensions: [".ts", ".tsx"],
    buildCommand: "npx tsc --noEmit",
    testCommand: "npx vitest run",
    lintCommand: "npx eslint .",
    rules: [
      { id: "ts-any", language: "typescript", pattern: /:\s*any\b/g, severity: "warning", message: "Avoid 'any' type — use specific types", fix: "Replace with specific type or 'unknown'" },
      { id: "ts-ignore", language: "typescript", pattern: /@ts-ignore/g, severity: "error", message: "@ts-ignore suppresses errors", fix: "Fix the underlying type error" },
      { id: "ts-expect-error", language: "typescript", pattern: /@ts-expect-error/g, severity: "info", message: "@ts-expect-error should be temporary" },
      { id: "ts-non-null", language: "typescript", pattern: /!\./g, severity: "warning", message: "Non-null assertion — can cause runtime errors", fix: "Use optional chaining or null check" },
      { id: "ts-enum", language: "typescript", pattern: /\benum\s+\w+/g, severity: "info", message: "Consider union types over enums for tree-shaking" },
    ],
    commonErrors: [
      { pattern: /Cannot find module '([^']+)'/, fix: "Install missing package: npm install $1" },
      { pattern: /Property '(\w+)' does not exist on type/, fix: "Add the property to the type definition or use type assertion" },
      { pattern: /Type '(\w+)' is not assignable to type '(\w+)'/, fix: "Check type compatibility — may need conversion or interface update" },
    ],
    bestPractices: [
      "Use strict mode (strict: true in tsconfig)",
      "Prefer interfaces over types for object shapes",
      "Use readonly for immutable properties",
      "Avoid default exports — use named exports",
      "Use satisfies operator for type validation",
    ]
  },
  python: {
    language: "Python",
    extensions: [".py"],
    buildCommand: "python -m py_compile",
    testCommand: "python -m pytest",
    lintCommand: "python -m ruff check .",
    rules: [
      { id: "py-bare-except", language: "python", pattern: /except\s*:/g, severity: "error", message: "Bare except catches everything including SystemExit", fix: "Use 'except Exception:' instead" },
      { id: "py-mutable-default", language: "python", pattern: /def\s+\w+\([^)]*=\s*(\[\]|\{\})/g, severity: "error", message: "Mutable default argument — shared across calls", fix: "Use None as default, create in function body" },
      { id: "py-global", language: "python", pattern: /\bglobal\s+\w+/g, severity: "warning", message: "Global variables make code hard to test" },
      { id: "py-star-import", language: "python", pattern: /from\s+\w+\s+import\s+\*/g, severity: "warning", message: "Star imports pollute namespace" },
    ],
    commonErrors: [
      { pattern: /ModuleNotFoundError: No module named '([^']+)'/, fix: "Install: pip install $1" },
      { pattern: /IndentationError/, fix: "Fix indentation — use consistent 4 spaces" },
      { pattern: /TypeError: .* argument/, fix: "Check function signature and argument types" },
    ],
    bestPractices: [
      "Use type hints for all function signatures",
      "Use dataclasses or Pydantic for structured data",
      "Follow PEP 8 style guide",
      "Use context managers for resource management",
      "Prefer pathlib over os.path",
    ]
  },
  go: {
    language: "Go",
    extensions: [".go"],
    buildCommand: "go build ./...",
    testCommand: "go test ./...",
    lintCommand: "golangci-lint run",
    rules: [
      { id: "go-err-ignore", language: "go", pattern: /\b\w+,\s*_\s*:?=\s*\w+\(/g, severity: "error", message: "Error return value ignored", fix: "Handle the error explicitly" },
      { id: "go-panic", language: "go", pattern: /\bpanic\(/g, severity: "warning", message: "panic in production code — use error returns", fix: "Return error instead of panicking" },
      { id: "go-init", language: "go", pattern: /func\s+init\(\)/g, severity: "info", message: "init() functions can cause subtle bugs" },
    ],
    commonErrors: [
      { pattern: /undefined: (\w+)/, fix: "Import the missing package or define the symbol" },
      { pattern: /cannot use .* as .* in/, fix: "Check type compatibility — may need type assertion or conversion" },
    ],
    bestPractices: [
      "Always handle errors explicitly",
      "Use defer for cleanup",
      "Keep interfaces small (1-3 methods)",
      "Use context.Context for cancellation",
      "Run go vet and staticcheck",
    ]
  },
  rust: {
    language: "Rust",
    extensions: [".rs"],
    buildCommand: "cargo check",
    testCommand: "cargo test",
    lintCommand: "cargo clippy",
    rules: [
      { id: "rs-unwrap", language: "rust", pattern: /\.unwrap\(\)/g, severity: "warning", message: ".unwrap() panics on None/Err", fix: "Use ? operator or match/if-let" },
      { id: "rs-clone", language: "rust", pattern: /\.clone\(\)/g, severity: "info", message: "Clone may indicate unnecessary copying" },
      { id: "rs-unsafe", language: "rust", pattern: /\bunsafe\b/g, severity: "warning", message: "unsafe block — document safety invariants" },
    ],
    commonErrors: [
      { pattern: /cannot borrow .* as mutable/, fix: "Check borrowing rules — split borrows or use Cell/RefCell" },
      { pattern: /value used after move/, fix: "Clone the value or restructure to avoid the move" },
    ],
    bestPractices: [
      "Use Result/Option instead of unwrap",
      "Prefer &str over String for function params",
      "Use derive macros for common traits",
      "Document unsafe blocks with SAFETY comments",
    ]
  },
  java: {
    language: "Java",
    extensions: [".java"],
    buildCommand: "mvn compile",
    testCommand: "mvn test",
    lintCommand: "mvn checkstyle:check",
    rules: [
      { id: "java-null", language: "java", pattern: /\bnull\b/g, severity: "info", message: "Consider Optional instead of null" },
      { id: "java-catch-exception", language: "java", pattern: /catch\s*\(\s*Exception\s/g, severity: "warning", message: "Catching generic Exception — be more specific" },
      { id: "java-system-out", language: "java", pattern: /System\.out\.print/g, severity: "warning", message: "Use a logger instead of System.out", fix: "Replace with SLF4J/Log4j logger" },
    ],
    commonErrors: [
      { pattern: /cannot find symbol/, fix: "Import the missing class or check spelling" },
      { pattern: /NullPointerException/, fix: "Add null checks or use Optional" },
    ],
    bestPractices: [
      "Use Optional for nullable returns",
      "Follow SOLID principles",
      "Use try-with-resources for AutoCloseable",
      "Prefer composition over inheritance",
    ]
  }
};

export function getReviewerForFile(filePath: string): LanguageReviewer | null {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext) return null;
  for (const reviewer of Object.values(LANGUAGE_REVIEWERS)) {
    if (reviewer.extensions.includes(ext)) return reviewer;
  }
  return null;
}

export function reviewCode(content: string, reviewer: LanguageReviewer): LanguageReviewRule[] {
  const violations: LanguageReviewRule[] = [];
  for (const rule of reviewer.rules) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (regex.test(content)) violations.push(rule);
  }
  return violations;
}

export function suggestFix(errorMessage: string, reviewer: LanguageReviewer): string | null {
  for (const { pattern, fix } of reviewer.commonErrors) {
    const match = errorMessage.match(pattern);
    if (match) {
      let result = fix;
      match.forEach((m, i) => { if (i > 0) result = result.replace(`$${i}`, m); });
      return result;
    }
  }
  return null;
}

export function buildReviewPrompt(language: string): string {
  const reviewer = LANGUAGE_REVIEWERS[language];
  if (!reviewer) return "";
  return [
    `## ${reviewer.language} Review Rules`,
    `Build: \`${reviewer.buildCommand}\``,
    `Test: \`${reviewer.testCommand}\``,
    `Lint: \`${reviewer.lintCommand}\``,
    "",
    "Best Practices:",
    ...reviewer.bestPractices.map(p => `- ${p}`),
  ].join("\n");
}
