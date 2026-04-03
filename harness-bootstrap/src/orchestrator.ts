import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectAnalysis, HarnessOutput, OrchestratorConfig } from "./types.js";

// ── Phase 3: Orchestrator Config Generator ──────────────────
// 별도 AI가 완성된 harness를 "기억"으로 읽고 작업하기 위한 설정

export function generateOrchestratorConfig(
  analysis: ProjectAnalysis,
  output: HarnessOutput
): OrchestratorConfig {
  const contextFiles = buildContextFileList(analysis, output);
  const verificationCommands = buildVerificationCommands(analysis);
  const phases = buildPhases(analysis, contextFiles, verificationCommands);

  return {
    phases,
    contextFiles,
    verificationCommands,
  };
}

function buildContextFileList(
  analysis: ProjectAnalysis,
  output: HarnessOutput
): string[] {
  const files: string[] = [
    "AGENTS.md",
    "docs/architecture/overview.md",
    "docs/architecture/dependency-graph.md",
    "docs/maps/module-map.md",
    "docs/maps/execution-plan.md",
  ];

  // Add convention files
  for (const doc of output.docsStructure) {
    if (doc.path.startsWith("docs/conventions/")) {
      files.push(doc.path);
    }
  }

  // Add sub-AGENTS.md
  for (const sub of output.subAgentsMd) {
    files.push(sub.path);
  }

  // Add ADR template
  files.push("docs/architecture/adr/000-template.md");

  return files;
}

function buildVerificationCommands(analysis: ProjectAnalysis): string[] {
  const cmds: string[] = [];
  if (analysis.commands.lint) cmds.push(analysis.commands.lint);
  if (analysis.commands.typecheck) cmds.push(analysis.commands.typecheck);
  if (analysis.commands.test) cmds.push(analysis.commands.test);
  return cmds;
}

function buildPhases(
  analysis: ProjectAnalysis,
  contextFiles: string[],
  verificationCommands: string[]
): OrchestratorConfig["phases"] {
  return [
    {
      name: "orient",
      description:
        "새 세션 시작 시 harness context를 로드한다. AGENTS.md → docs/architecture/overview.md → module-map → 관련 sub-AGENTS.md 순서로 읽는다.",
      contextFiles: [
        "AGENTS.md",
        "docs/architecture/overview.md",
        "docs/maps/module-map.md",
      ],
      commands: [],
    },
    {
      name: "plan",
      description:
        "태스크를 분석하고 실행 계획을 세운다. docs/maps/execution-plan.md의 워크플로우를 따른다. 아키텍처 결정이 필요하면 ADR 템플릿을 사용한다.",
      contextFiles: [
        "docs/maps/execution-plan.md",
        "docs/architecture/dependency-graph.md",
        "docs/architecture/adr/000-template.md",
      ],
      commands: [],
    },
    {
      name: "implement",
      description:
        "계획에 따라 구현한다. 해당 디렉토리의 sub-AGENTS.md와 conventions를 참조한다. Judgment boundaries (NEVER/ASK/ALWAYS)를 준수한다.",
      contextFiles: contextFiles.filter(
        (f) => f.includes("conventions/") || f.includes("AGENTS.md")
      ),
      commands: [],
    },
    {
      name: "verify",
      description:
        "구현 완료 후 verification pipeline을 실행한다. 모든 체크가 통과해야 태스크 완료로 간주한다.",
      contextFiles: ["docs/maps/execution-plan.md"],
      commands: verificationCommands,
    },
    {
      name: "review",
      description:
        "자체 변경사항을 리뷰한다. 아키텍처 제약 위반, 스타일 위반, 테스트 누락을 확인한다. 문제가 있으면 implement → verify를 반복한다.",
      contextFiles: [
        "AGENTS.md",
        "docs/architecture/dependency-graph.md",
      ],
      commands: verificationCommands,
    },
  ];
}

// ── Orchestrator Prompt Generator ───────────────────────────
// 별도 AI 인스턴스에게 줄 시스템 프롬프트를 생성

export function generateOrchestratorPrompt(
  analysis: ProjectAnalysis,
  config: OrchestratorConfig
): string {
  const sections: string[] = [];

  sections.push(`# Harness-Aware Agent System Prompt`);
  sections.push("");
  sections.push(`You are working on the "${analysis.name}" project.`);
  sections.push(`Before starting any task, you MUST read the harness context files in order.`);
  sections.push(`These files are your long-term memory — they contain all architectural decisions,`);
  sections.push(`coding conventions, boundaries, and verification requirements.`);
  sections.push("");

  sections.push(`## Operating Phases`);
  sections.push("");

  for (const phase of config.phases) {
    sections.push(`### Phase: ${phase.name}`);
    sections.push(`${phase.description}`);
    sections.push("");
    if (phase.contextFiles.length > 0) {
      sections.push(`**Read these files:**`);
      for (const f of phase.contextFiles) {
        sections.push(`- \`${f}\``);
      }
      sections.push("");
    }
    if (phase.commands.length > 0) {
      sections.push(`**Run these commands:**`);
      for (const cmd of phase.commands) {
        sections.push(`- \`${cmd}\``);
      }
      sections.push("");
    }
  }

  sections.push(`## Harness Context Files (Priority Order)`);
  sections.push("");
  for (let i = 0; i < config.contextFiles.length; i++) {
    sections.push(`${i + 1}. \`${config.contextFiles[i]}\``);
  }
  sections.push("");

  sections.push(`## Critical Rules`);
  sections.push("");
  sections.push(`1. ALWAYS read AGENTS.md before starting work on any task.`);
  sections.push(`2. NEVER violate the Judgment Boundaries (NEVER/ASK/ALWAYS sections).`);
  sections.push(`3. After implementation, ALWAYS run the verification pipeline:`);
  for (const cmd of config.verificationCommands) {
    sections.push(`   - \`${cmd}\``);
  }
  sections.push(`4. If verification fails, fix and re-verify. Do not submit failing code.`);
  sections.push(`5. If an architectural decision is needed, create an ADR in docs/architecture/adr/.`);
  sections.push(`6. If you encounter something not covered by the harness, ASK before proceeding.`);
  sections.push("");

  sections.push(`## Self-Correction Loop`);
  sections.push("");
  sections.push(`When a task fails or you receive feedback:`);
  sections.push(`1. Identify what went wrong`);
  sections.push(`2. Check if the harness should be updated to prevent recurrence`);
  sections.push(`3. If yes, propose a specific change to AGENTS.md or a new linter rule`);
  sections.push(`4. Fix the immediate issue`);
  sections.push(`5. Re-run verification`);
  sections.push("");

  sections.push(`## Memory Model`);
  sections.push("");
  sections.push(`You have NO persistent memory between sessions.`);
  sections.push(`The harness files ARE your memory. Everything you need to know is encoded in:`);
  sections.push(`- AGENTS.md (rules, boundaries, conventions)`);
  sections.push(`- docs/architecture/ (architectural decisions and constraints)`);
  sections.push(`- docs/maps/ (navigation and execution plans)`);
  sections.push(`- docs/conventions/ (language and testing standards)`);
  sections.push(`- Sub-directory AGENTS.md files (package-specific rules)`);
  sections.push("");
  sections.push(`If you learn something important during a task that future sessions should know,`);
  sections.push(`propose adding it to the appropriate harness file.`);

  return sections.join("\n");
}

// ── Write Harness to Disk ───────────────────────────────────

export function writeHarnessToDisk(
  projectRoot: string,
  output: HarnessOutput,
  orchestratorPrompt: string
): string[] {
  const written: string[] = [];
  const absRoot = path.resolve(projectRoot);

  // Write AGENTS.md
  const agentsPath = path.join(absRoot, "AGENTS.md");
  fs.writeFileSync(agentsPath, output.agentsMd, "utf-8");
  written.push("AGENTS.md");

  // Create CLAUDE.md symlink
  if (output.claudeMdSymlink) {
    const claudePath = path.join(absRoot, "CLAUDE.md");
    if (!fs.existsSync(claudePath)) {
      try {
        fs.symlinkSync("AGENTS.md", claudePath);
        written.push("CLAUDE.md -> AGENTS.md (symlink)");
      } catch {
        // Symlink failed, copy instead
        fs.writeFileSync(claudePath, output.agentsMd, "utf-8");
        written.push("CLAUDE.md (copy)");
      }
    }
  }

  // Write docs/
  for (const doc of output.docsStructure) {
    const docPath = path.join(absRoot, doc.path);
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, doc.content, "utf-8");
    written.push(doc.path);
  }

  // Write sub-AGENTS.md
  for (const sub of output.subAgentsMd) {
    const subPath = path.join(absRoot, sub.path);
    fs.mkdirSync(path.dirname(subPath), { recursive: true });
    fs.writeFileSync(subPath, sub.content, "utf-8");
    written.push(sub.path);
  }

  // Write orchestrator prompt
  const orchPath = path.join(absRoot, "docs/orchestrator-prompt.md");
  fs.mkdirSync(path.dirname(orchPath), { recursive: true });
  fs.writeFileSync(orchPath, orchestratorPrompt, "utf-8");
  written.push("docs/orchestrator-prompt.md");

  // Write global config (to home dir reference)
  const globalRef = path.join(absRoot, "docs/global-agents-md-reference.md");
  fs.writeFileSync(
    globalRef,
    `# Global AGENTS.md Reference\n\nCopy the content below to \`~/.codex/AGENTS.md\`:\n\n---\n\n${output.globalAgentsMd}`,
    "utf-8"
  );
  written.push("docs/global-agents-md-reference.md");

  // Write config.toml reference
  const configRef = path.join(absRoot, "docs/config-toml-reference.md");
  fs.writeFileSync(
    configRef,
    `# config.toml Reference\n\nCopy the content below to \`~/.codex/config.toml\`:\n\n---\n\n\`\`\`toml\n${output.configToml}\`\`\``,
    "utf-8"
  );
  written.push("docs/config-toml-reference.md");

  return written;
}
