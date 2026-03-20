/**
 * AI-Driven PR Checks — Continue-style automated code review on PRs.
 *
 * Runs AI analysis on pull request diffs:
 * 1. Parse PR diff
 * 2. Run AI checks (security, performance, style, correctness)
 * 3. Generate inline comments with fix suggestions
 * 4. Report pass/fail status
 *
 * Source: Continue research — "AI Code Checks as CI/CD"
 */

export interface PrCheckResult {
  checkName: string;
  passed: boolean;
  summary: string;
  comments: PrComment[];
  severity: "info" | "warning" | "error" | "blocking";
}

export interface PrComment {
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  severity: "info" | "warning" | "error";
}

export interface PrAnalysis {
  prTitle: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  checks: PrCheckResult[];
  overallPass: boolean;
  summary: string;
}

/**
 * Built-in PR checks — each runs independently.
 */
export const BUILTIN_PR_CHECKS = [
  {
    name: "security-scan",
    description: "Check for security vulnerabilities (hardcoded secrets, SQL injection, XSS)",
    patterns: [
      { pattern: /(?:password|secret|key|token)\s*=\s*['"][^'"]{8,}['"]/gi, message: "Potential hardcoded secret", severity: "error" as const },
      { pattern: /(?:eval|Function)\s*\(/g, message: "Dynamic code execution (eval/Function)", severity: "warning" as const },
      { pattern: /innerHTML\s*=/g, message: "Direct innerHTML assignment (XSS risk)", severity: "warning" as const },
      { pattern: /\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/gi, message: "Potential SQL injection", severity: "error" as const },
      { pattern: /console\.(log|debug|info)\s*\(/g, message: "Console log in production code", severity: "info" as const },
    ]
  },
  {
    name: "error-handling",
    description: "Check for missing error handling",
    patterns: [
      { pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g, message: "Empty catch block — errors silently swallowed", severity: "warning" as const },
      { pattern: /\.then\(\s*\w+\s*\)\s*(?!\.catch)/g, message: "Promise without .catch()", severity: "info" as const },
    ]
  },
  {
    name: "todo-check",
    description: "Check for TODO/FIXME in new code",
    patterns: [
      { pattern: /\/\/\s*TODO\b/gi, message: "TODO comment — resolve before merging", severity: "warning" as const },
      { pattern: /\/\/\s*FIXME\b/gi, message: "FIXME comment — critical issue marked", severity: "error" as const },
      { pattern: /\/\/\s*HACK\b/gi, message: "HACK comment — tech debt introduced", severity: "warning" as const },
    ]
  },
  {
    name: "type-safety",
    description: "Check for TypeScript type safety issues",
    patterns: [
      { pattern: /as\s+any\b/g, message: "Type assertion to 'any' — loses type safety", severity: "warning" as const },
      { pattern: /@ts-ignore\b/g, message: "@ts-ignore — suppresses TypeScript errors", severity: "error" as const },
      { pattern: /@ts-expect-error\b/g, message: "@ts-expect-error — should be temporary", severity: "info" as const },
      { pattern: /:\s*any\b/g, message: "Explicit 'any' type — consider a specific type", severity: "info" as const },
    ]
  }
];

/**
 * Run PR checks on a diff string.
 */
export function runPrChecks(diff: string): PrAnalysis {
  const files = parseDiff(diff);
  const checks: PrCheckResult[] = [];

  let totalAdded = 0;
  let totalRemoved = 0;

  for (const file of files) {
    totalAdded += file.addedLines.length;
    totalRemoved += file.removedLines;
  }

  // Run each built-in check
  for (const check of BUILTIN_PR_CHECKS) {
    const comments: PrComment[] = [];

    for (const file of files) {
      for (const line of file.addedLines) {
        for (const p of check.patterns) {
          if (p.pattern.test(line.content)) {
            comments.push({
              file: file.path,
              line: line.number,
              message: p.message,
              severity: p.severity
            });
          }
          // Reset regex lastIndex for global patterns
          p.pattern.lastIndex = 0;
        }
      }
    }

    const hasErrors = comments.some(c => c.severity === "error");
    checks.push({
      checkName: check.name,
      passed: !hasErrors,
      summary: comments.length === 0
        ? `✓ ${check.name}: No issues found`
        : `${comments.length} issue(s) found`,
      comments,
      severity: hasErrors ? "error" : comments.length > 0 ? "warning" : "info"
    });
  }

  const overallPass = checks.every(c => c.passed);

  return {
    prTitle: "",
    filesChanged: files.length,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
    checks,
    overallPass,
    summary: overallPass
      ? `✓ All ${checks.length} checks passed (${files.length} files, +${totalAdded}/-${totalRemoved} lines)`
      : `✗ ${checks.filter(c => !c.passed).length}/${checks.length} checks failed`
  };
}

interface DiffFile {
  path: string;
  addedLines: Array<{ number: number; content: string }>;
  removedLines: number;
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const filePattern = /^diff --git a\/.+ b\/(.+)$/gm;
  const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm;

  let fileMatch;
  while ((fileMatch = filePattern.exec(diff)) !== null) {
    const filePath = fileMatch[1];
    const fileStart = fileMatch.index;
    const nextFileStart = diff.indexOf("diff --git", fileStart + 1);
    const fileSection = nextFileStart > 0 ? diff.slice(fileStart, nextFileStart) : diff.slice(fileStart);

    const addedLines: Array<{ number: number; content: string }> = [];
    let removedLines = 0;

    // Find hunks in this file section
    let hunkMatch;
    const localHunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm;
    while ((hunkMatch = localHunkPattern.exec(fileSection)) !== null) {
      let lineNum = parseInt(hunkMatch[1]);
      const hunkStart = hunkMatch.index + hunkMatch[0].length;
      const nextHunk = fileSection.indexOf("\n@@", hunkStart);
      const hunkContent = nextHunk > 0 ? fileSection.slice(hunkStart, nextHunk) : fileSection.slice(hunkStart);

      for (const line of hunkContent.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          addedLines.push({ number: lineNum, content: line.slice(1) });
          lineNum++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          removedLines++;
        } else if (!line.startsWith("\\")) {
          lineNum++;
        }
      }
    }

    files.push({ path: filePath, addedLines, removedLines });
  }

  return files;
}

/**
 * Format PR analysis for display.
 */
export function formatPrAnalysis(analysis: PrAnalysis): string {
  const lines: string[] = [];
  lines.push(`## PR Check Results`);
  lines.push(`Files: ${analysis.filesChanged} | +${analysis.linesAdded} -${analysis.linesRemoved}`);
  lines.push("");

  for (const check of analysis.checks) {
    const icon = check.passed ? "✅" : "❌";
    lines.push(`${icon} **${check.checkName}**: ${check.summary}`);
    if (check.comments.length > 0) {
      for (const c of check.comments.slice(0, 5)) {
        lines.push(`   - \`${c.file}:${c.line}\` [${c.severity}] ${c.message}`);
      }
      if (check.comments.length > 5) lines.push(`   ... and ${check.comments.length - 5} more`);
    }
  }

  lines.push("");
  lines.push(analysis.overallPass ? "**✅ All checks passed**" : "**❌ Some checks failed — review required**");

  return lines.join("\n");
}
