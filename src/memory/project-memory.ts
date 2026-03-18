/**
 * Project Memory System (inspired by oh-my-claudecode learner).
 *
 * Learns from tool execution history and persists knowledge across sessions:
 * - Hot paths: files most frequently read/modified
 * - Build commands: discovered from bash tool outputs
 * - Test commands: discovered from bash tool outputs
 * - Error patterns: recurring failure signatures
 * - Dependencies: package manager and version info
 * - Architecture notes: inferred from repo structure
 *
 * Storage: .agent/memory/project.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists } from "../core/utils.js";

export interface ProjectMemory {
  version: 1;
  updatedAt: string;
  hotPaths: Record<string, number>;
  buildCommands: string[];
  testCommands: string[];
  errorPatterns: string[];
  dependencies: Record<string, string>;
  architecture: string[];
  customNotes: string[];
  toolStats: Record<string, { calls: number; successes: number; failures: number }>;
}

function createEmptyMemory(): ProjectMemory {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    hotPaths: {},
    buildCommands: [],
    testCommands: [],
    errorPatterns: [],
    dependencies: {},
    architecture: [],
    customNotes: [],
    toolStats: {}
  };
}

export class ProjectMemoryStore {
  private memory: ProjectMemory | null = null;

  constructor(
    private readonly cwd: string,
    private readonly localDirName: string = ".agent"
  ) {}

  private get filePath(): string {
    return path.join(this.cwd, this.localDirName, "memory", "project.json");
  }

  async load(): Promise<ProjectMemory> {
    if (this.memory) return this.memory;
    if (await fileExists(this.filePath)) {
      this.memory = JSON.parse(await fs.readFile(this.filePath, "utf8")) as ProjectMemory;
    } else {
      this.memory = createEmptyMemory();
    }
    return this.memory;
  }

  async save(): Promise<void> {
    if (!this.memory) return;
    this.memory.updatedAt = new Date().toISOString();
    await ensureDir(path.dirname(this.filePath));
    await fs.writeFile(this.filePath, JSON.stringify(this.memory, null, 2), "utf8");
  }

  async recordFileAccess(filePath: string): Promise<void> {
    const mem = await this.load();
    const normalized = filePath.replace(/\\/g, "/");
    mem.hotPaths[normalized] = (mem.hotPaths[normalized] ?? 0) + 1;
    await this.save();
  }

  async recordToolCall(toolName: string, success: boolean): Promise<void> {
    const mem = await this.load();
    if (!mem.toolStats[toolName]) {
      mem.toolStats[toolName] = { calls: 0, successes: 0, failures: 0 };
    }
    mem.toolStats[toolName].calls += 1;
    if (success) {
      mem.toolStats[toolName].successes += 1;
    } else {
      mem.toolStats[toolName].failures += 1;
    }
    await this.save();
  }

  async learnFromBashOutput(command: string, output: string): Promise<void> {
    const mem = await this.load();

    // Detect build commands
    if (/\b(npm run build|tsc|webpack|vite build|esbuild|cargo build|go build)\b/.test(command)) {
      if (!mem.buildCommands.includes(command)) {
        mem.buildCommands.push(command);
      }
    }

    // Detect test commands
    if (/\b(npm test|vitest|jest|pytest|cargo test|go test)\b/.test(command)) {
      if (!mem.testCommands.includes(command)) {
        mem.testCommands.push(command);
      }
    }

    // Detect error patterns
    if (output.includes("Error:") || output.includes("FAIL") || output.includes("error[")) {
      const errorLine = output.split("\n").find((l) =>
        /error|Error|FAIL|panic|exception/i.test(l)
      );
      if (errorLine) {
        const trimmed = errorLine.trim().slice(0, 200);
        if (!mem.errorPatterns.includes(trimmed)) {
          mem.errorPatterns.push(trimmed);
          if (mem.errorPatterns.length > 50) {
            mem.errorPatterns = mem.errorPatterns.slice(-50);
          }
        }
      }
    }

    // Detect dependencies from package.json reads
    if (command.includes("cat package.json") || command.includes("cat Cargo.toml")) {
      try {
        const pkg = JSON.parse(output);
        if (pkg.dependencies) {
          Object.assign(mem.dependencies, pkg.dependencies);
        }
      } catch {
        // not JSON
      }
    }

    await this.save();
  }

  async getHotPaths(limit = 20): Promise<Array<{ path: string; count: number }>> {
    const mem = await this.load();
    return Object.entries(mem.hotPaths)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([p, count]) => ({ path: p, count }));
  }

  async getContext(): Promise<string> {
    const mem = await this.load();
    const lines: string[] = [];

    if (mem.buildCommands.length > 0) {
      lines.push(`Build commands: ${mem.buildCommands.join(", ")}`);
    }
    if (mem.testCommands.length > 0) {
      lines.push(`Test commands: ${mem.testCommands.join(", ")}`);
    }

    const hotPaths = await this.getHotPaths(10);
    if (hotPaths.length > 0) {
      lines.push(`Hot files: ${hotPaths.map((p) => p.path).join(", ")}`);
    }

    if (mem.errorPatterns.length > 0) {
      lines.push(`Recent errors: ${mem.errorPatterns.slice(-5).join(" | ")}`);
    }

    if (mem.architecture.length > 0) {
      lines.push(`Architecture: ${mem.architecture.join(", ")}`);
    }

    return lines.length > 0 ? `Project memory:\n${lines.join("\n")}` : "";
  }

  async addNote(note: string): Promise<void> {
    const mem = await this.load();
    if (!mem.customNotes.includes(note)) {
      mem.customNotes.push(note);
      await this.save();
    }
  }
}
