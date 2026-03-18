import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import type { WorkerLease, WorkerTransport } from "../core/types.js";
import { createId, nowIso, shellEscape } from "../core/utils.js";

const require = createRequire(import.meta.url);
const TSX_CLI_PATH = require.resolve("tsx/cli");

export function detectTmuxAvailability(): boolean {
  if (!process.env.TMUX) {
    return false;
  }
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return result.status === 0;
}

export interface WorkerInvocation {
  sessionId: string;
  taskId: string;
  role: string;
  provider: string;
  promptFile: string;
  cwd: string;
}

export class LocalWorkerManager {
  constructor(private readonly maxWorkers: number) {}

  selectTransport(preferTmux: boolean): WorkerTransport {
    if (preferTmux && detectTmuxAvailability()) {
      return "tmux";
    }
    // Default to inline — subprocess workers have unreliable retry behavior
    // for LLM responses. Inline mode handles retries in-process.
    return "inline";
  }

  assertWithinLimit(current: number): void {
    // Allow generous headroom — enforcer loop creates many tasks across rounds
    if (current >= this.maxWorkers * 3) {
      throw new Error(`Worker limit exceeded: ${current} >= ${this.maxWorkers}`);
    }
  }

  spawnLease(role: string, transport: WorkerTransport): WorkerLease {
    return {
      id: createId("wrk"),
      role,
      transport,
      startedAt: nowIso()
    };
  }

  async runSubprocess(invocation: WorkerInvocation): Promise<WorkerLease> {
    const lease = this.spawnLease(invocation.role, "subprocess");
    const commandArgs = this.getWorkerArgs(invocation);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, commandArgs, {
        cwd: invocation.cwd,
        stdio: "inherit"
      });
      lease.pid = child.pid;
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Worker exited with code ${code}`));
      });
    });
    return lease;
  }

  async runTmux(invocation: WorkerInvocation): Promise<WorkerLease> {
    const lease = this.spawnLease(invocation.role, "tmux");
    const command = [
      shellEscape(process.execPath),
      ...this.getWorkerArgs(invocation).map((value) => shellEscape(value))
    ].join(" ");
    const result = spawnSync("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", command], {
      cwd: invocation.cwd,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      throw new Error(`tmux worker failed to start: ${result.stderr}`);
    }
    lease.paneId = result.stdout.trim();
    return lease;
  }

  private getWorkerArgs(invocation: WorkerInvocation): string[] {
    const cliEntry = process.env.AGENT40_CLI_ENTRY ?? process.argv[1];
    const baseArgs = [
      "_worker",
      "--session",
      invocation.sessionId,
      "--task",
      invocation.taskId,
      "--role",
      invocation.role,
      "--provider",
      invocation.provider,
      "--prompt-file",
      invocation.promptFile
    ];
    if (path.extname(cliEntry) === ".ts") {
      return [TSX_CLI_PATH, cliEntry, ...baseArgs];
    }
    return [cliEntry, ...baseArgs];
  }
}
