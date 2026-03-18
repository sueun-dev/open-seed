import crypto from "node:crypto";
import fs from "node:fs/promises";

export interface HashedLine {
  lineNumber: number;
  hash: string;
  text: string;
}

export interface HashEdit {
  type: "replace" | "delete" | "insertAfter";
  hash: string;
  newText?: string;
}

export class StaleHashEditError extends Error {}

function computeHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
}

export async function readFileWithHashes(filePath: string): Promise<HashedLine[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.split("\n").map((text, index) => ({
    lineNumber: index + 1,
    hash: computeHash(text),
    text
  }));
}

export async function renderFileWithHashes(filePath: string): Promise<string> {
  const lines = await readFileWithHashes(filePath);
  return lines.map((line) => `${line.lineNumber}#${line.hash}| ${line.text}`).join("\n");
}

export async function applyHashEdits(filePath: string, edits: HashEdit[]): Promise<void> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const current = lines.map((text) => computeHash(text));

  for (const edit of edits) {
    const index = current.findIndex((hash) => hash === edit.hash);
    if (index === -1) {
      throw new StaleHashEditError(`Hash ${edit.hash} no longer matches file contents`);
    }
    if (edit.type === "replace") {
      lines[index] = edit.newText ?? "";
      current[index] = computeHash(lines[index]);
      continue;
    }
    if (edit.type === "delete") {
      lines.splice(index, 1);
      current.splice(index, 1);
      continue;
    }
    lines.splice(index + 1, 0, edit.newText ?? "");
    current.splice(index + 1, 0, computeHash(edit.newText ?? ""));
  }

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
}
