import { checkComments } from "../tools/comment-checker.js";

export async function runCheckCommentsCommand(errorsOnly?: boolean): Promise<void> {
  const cwd = process.cwd();
  console.log("Scanning for problematic comments...\n");

  const result = await checkComments({
    cwd,
    includeWarnings: !errorsOnly
  });

  if (result.findings.length === 0) {
    console.log(`Scanned ${result.files} files. No issues found.`);
    return;
  }

  for (const finding of result.findings) {
    const icon = finding.severity === "error" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
    console.log(`  ${icon} ${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`);
  }

  console.log("");
  console.log(`Scanned ${result.files} files.`);
  const parts: string[] = [];
  if (result.summary.todos > 0) parts.push(`${result.summary.todos} TODO`);
  if (result.summary.fixmes > 0) parts.push(`${result.summary.fixmes} FIXME`);
  if (result.summary.hacks > 0) parts.push(`${result.summary.hacks} HACK`);
  if (result.summary.commentedCode > 0) parts.push(`${result.summary.commentedCode} commented-out code`);
  if (result.summary.emptyComments > 0) parts.push(`${result.summary.emptyComments} empty comments`);
  console.log(`Found: ${parts.join(", ")}`);

  const errors = result.findings.filter((f) => f.severity === "error");
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
