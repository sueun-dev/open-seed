/**
 * Deep Interview Mode — OMC-style Socratic questioning.
 *
 * Before complex tasks, conducts a structured interview to:
 * 1. Clarify vague requirements
 * 2. Identify scope boundaries
 * 3. Surface implicit assumptions
 * 4. Detect potential conflicts
 * 5. Build a shared understanding
 *
 * Source: oh-my-claudecode "Deep Interview System"
 * Source: MetaGPT "Document-First Approach"
 */

import type { IntentAnalysis } from "./intent-gate.js";

export interface InterviewQuestion {
  id: string;
  question: string;
  category: "scope" | "constraints" | "dependencies" | "testing" | "deployment" | "edge-cases";
  importance: "critical" | "important" | "nice-to-have";
  /** Auto-answerable from codebase analysis */
  autoAnswerable: boolean;
  /** Auto-answer if available */
  autoAnswer?: string;
}

export interface InterviewResult {
  questions: InterviewQuestion[];
  answers: Map<string, string>;
  /** Refined task description after interview */
  refinedTask: string;
  /** Discovered requirements not in original prompt */
  discoveredRequirements: string[];
  /** Identified risks */
  risks: string[];
  /** Suggested approach */
  approach: string;
}

/**
 * Determine if a task needs an interview before execution.
 */
export function needsInterview(task: string, intent: IntentAnalysis): boolean {
  // Always interview for high-risk tasks
  if (intent.risk === "high") return true;
  // Interview for repo-wide or cross-cutting scope
  if (intent.scope === "repo-wide" || intent.scope === "cross-cutting") return true;
  // Interview for architectural tasks
  if (intent.action === "migrate" || intent.action === "refactor") return true;
  // Interview for vague tasks
  if (task.split(/\s+/).length < 8 && intent.action === "build") return true;
  // Interview for tasks with "improve" or open-ended language
  if (/improve|better|optimize|refactor|redesign|rethink/i.test(task)) return true;
  return false;
}

/**
 * Generate interview questions based on task analysis.
 */
export function generateInterviewQuestions(
  task: string,
  intent: IntentAnalysis,
  codebaseInfo: { hasTests: boolean; hasCi: boolean; languages: string[]; frameworks: string[] }
): InterviewQuestion[] {
  const questions: InterviewQuestion[] = [];
  let qId = 0;

  const q = (question: string, category: InterviewQuestion["category"], importance: InterviewQuestion["importance"], autoAnswerable = false, autoAnswer?: string) => {
    questions.push({ id: `iq-${++qId}`, question, category, importance, autoAnswerable, autoAnswer });
  };

  // Scope questions
  if (intent.scope !== "single-file") {
    q("Which files/modules are in scope? Which are explicitly out of scope?", "scope", "critical");
  }
  if (intent.action === "build" || intent.action === "add") {
    q("What is the expected behavior when this feature is complete? How will you verify it works?", "scope", "critical");
  }

  // Constraint questions
  if (intent.risk === "high") {
    q("Are there any breaking changes we need to avoid? What backward compatibility is required?", "constraints", "critical");
  }
  q("Are there performance requirements or constraints (response time, memory, etc.)?", "constraints", "important");

  // Dependency questions
  if (/api|endpoint|service|external/i.test(task)) {
    q("Are there external APIs or services involved? What are their contracts?", "dependencies", "critical");
  }
  if (/database|db|migration|schema/i.test(task)) {
    q("Will this require database schema changes? Is there existing data to migrate?", "dependencies", "critical");
  }

  // Testing questions
  if (codebaseInfo.hasTests) {
    q("What test scenarios should be covered? Are there edge cases to watch for?", "testing", "important",
      true, "Existing test framework detected — will add tests matching current patterns");
  } else {
    q("Should we set up testing? What level: unit, integration, E2E?", "testing", "important");
  }

  // Edge cases
  q("What should happen with invalid input? Empty states? Network failures?", "edge-cases", "nice-to-have");
  if (/auth|login|user/i.test(task)) {
    q("What about unauthorized access? Session expiry? Multiple sessions?", "edge-cases", "important");
  }

  // Deployment
  if (intent.action === "deploy" || /deploy|production|ship/i.test(task)) {
    q("What's the deployment target? Any environment-specific configs needed?", "deployment", "critical");
    q("Is there a rollback plan if something goes wrong?", "deployment", "important");
  }

  return questions;
}

/**
 * Build a refined task prompt incorporating interview answers.
 */
export function buildRefinedTaskFromInterview(
  originalTask: string,
  questions: InterviewQuestion[],
  answers: Map<string, string>
): string {
  const sections: string[] = [];

  sections.push(`## Original Task\n${originalTask}`);

  // Group answers by category
  const byCategory = new Map<string, string[]>();
  for (const q of questions) {
    const answer = answers.get(q.id) ?? q.autoAnswer;
    if (!answer) continue;
    const list = byCategory.get(q.category) ?? [];
    list.push(`- **${q.question}**\n  → ${answer}`);
    byCategory.set(q.category, list);
  }

  for (const [category, items] of byCategory) {
    sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}\n${items.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Build a PRD (Product Requirements Document) from interview results.
 * MetaGPT-inspired document-first approach.
 */
export function buildPRDFromInterview(
  task: string,
  intent: IntentAnalysis,
  answers: Map<string, string>
): string {
  const sections: string[] = [];

  sections.push(`# PRD: ${task}`);
  sections.push(`\n## Objective\n${task}`);
  sections.push(`\n## Scope\n- Action: ${intent.action}\n- Scope: ${intent.scope}\n- Risk: ${intent.risk}`);
  sections.push(`\n## Constraints\n${Array.from(answers.entries()).filter(([k]) => k.includes("constraint")).map(([_, v]) => `- ${v}`).join("\n") || "- None specified"}`);
  sections.push(`\n## Success Criteria\n- [ ] All planned changes implemented\n- [ ] Tests pass\n- [ ] No regressions\n- [ ] Build succeeds`);
  sections.push(`\n## Roles Required\n${intent.suggestedRoles.map(r => `- ${r}`).join("\n")}`);

  return sections.join("\n");
}
