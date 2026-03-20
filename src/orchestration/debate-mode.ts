/**
 * Multi-Agent Debate Mode — MetaGPT-style consensus through structured debate.
 *
 * For complex decisions, multiple specialist agents argue their positions:
 * 1. Each agent proposes their solution
 * 2. Agents critique each other's proposals
 * 3. Synthesizer merges the best ideas
 * 4. Final consensus is reached
 *
 * Source: MetaGPT "Debate Mode" + CrewAI "Hierarchical Process"
 */

export interface DebatePosition {
  roleId: string;
  roleName: string;
  proposal: string;
  reasoning: string;
  risks: string[];
  tradeoffs: string[];
}

export interface DebateCritique {
  fromRole: string;
  targetRole: string;
  agrees: string[];
  disagrees: string[];
  suggestions: string[];
}

export interface DebateRound {
  roundNumber: number;
  positions: DebatePosition[];
  critiques: DebateCritique[];
}

export interface DebateResult {
  topic: string;
  rounds: DebateRound[];
  consensus: string;
  dissent: string[];
  finalDecision: string;
  confidence: number;
}

/**
 * Determine if a task warrants multi-agent debate.
 */
export function needsDebate(task: string): boolean {
  // Architectural decisions benefit from debate
  if (/architect|design|pattern|approach|strategy|tradeoff/i.test(task)) return true;
  // Technology choices
  if (/choose|select|compare|which.*better|should.*use/i.test(task)) return true;
  // Migration decisions
  if (/migrate|upgrade|switch.*from.*to/i.test(task)) return true;
  return false;
}

/**
 * Select debate participants based on the topic.
 */
export function selectDebateParticipants(task: string): string[] {
  const participants = new Set<string>();

  // Always include architect and reviewer
  participants.add("planner");
  participants.add("reviewer");

  // Topic-specific participants
  if (/frontend|ui|component/i.test(task)) {
    participants.add("frontend-engineer");
    participants.add("ux-designer");
  }
  if (/backend|api|server/i.test(task)) {
    participants.add("backend-engineer");
    participants.add("api-designer");
  }
  if (/security|auth/i.test(task)) {
    participants.add("security-auditor");
  }
  if (/performance|speed|scale/i.test(task)) {
    participants.add("performance-engineer");
  }
  if (/database|schema/i.test(task)) {
    participants.add("db-engineer");
  }
  if (/deploy|infra/i.test(task)) {
    participants.add("devops-engineer");
  }
  if (/test/i.test(task)) {
    participants.add("test-engineer");
  }

  return Array.from(participants).slice(0, 5); // Max 5 debaters
}

/**
 * Build debate prompt for a participant.
 */
export function buildDebatePrompt(
  topic: string,
  roleId: string,
  previousPositions: DebatePosition[]
): string {
  const lines = [
    `## Debate: ${topic}`,
    `\nYou are the ${roleId} specialist. Present your position on this topic.`,
    ""
  ];

  if (previousPositions.length > 0) {
    lines.push("### Previous Positions:");
    for (const pos of previousPositions) {
      lines.push(`\n**${pos.roleName}**: ${pos.proposal}`);
      lines.push(`Reasoning: ${pos.reasoning}`);
      if (pos.risks.length > 0) lines.push(`Risks: ${pos.risks.join(", ")}`);
    }
    lines.push("\n### Your Turn:");
    lines.push("Consider the above positions. You may agree, disagree, or propose alternatives.");
  }

  lines.push("\nRespond with:");
  lines.push('{"proposal": "your solution", "reasoning": "why", "risks": ["risk1"], "tradeoffs": ["tradeoff1"]}');

  return lines.join("\n");
}

/**
 * Build synthesis prompt to merge debate positions.
 */
export function buildDebateSynthesisPrompt(topic: string, positions: DebatePosition[]): string {
  const lines = [
    `## Debate Synthesis: ${topic}`,
    "",
    "You are the orchestrator. Synthesize these specialist positions into a final decision:",
    ""
  ];

  for (const pos of positions) {
    lines.push(`### ${pos.roleName}`);
    lines.push(`Proposal: ${pos.proposal}`);
    lines.push(`Reasoning: ${pos.reasoning}`);
    lines.push(`Risks: ${pos.risks.join(", ") || "none"}`);
    lines.push(`Tradeoffs: ${pos.tradeoffs.join(", ") || "none"}`);
    lines.push("");
  }

  lines.push("Synthesize the best ideas into a final decision. Address conflicts explicitly.");
  lines.push('Respond: {"consensus": "merged solution", "dissent": ["unresolved disagreements"], "finalDecision": "what to do", "confidence": 0.0-1.0}');

  return lines.join("\n");
}
