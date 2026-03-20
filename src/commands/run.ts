import { attachLiveSessionOutput } from "./live-session.js";
import { runEngine } from "../orchestration/engine.js";
import { readFileSync } from "node:fs";

export async function runRunCommand(task: string): Promise<void> {
  // [FIX #7] If AGI_PROMPT_FILE env is set, read full prompt from file (avoids CLI arg length limits)
  if (process.env.AGI_PROMPT_FILE && task === "__AGI_PROMPT_FILE__") {
    try { task = readFileSync(process.env.AGI_PROMPT_FILE, "utf-8"); } catch { /* fallback to original task */ }
  }
  const cwd = process.cwd();
  let follower: Awaited<ReturnType<typeof attachLiveSessionOutput>> | undefined;

  try {
    const result = await runEngine({
      cwd,
      task,
      mode: "run",
      async onSessionReady(sessionId) {
        try {
          follower = await attachLiveSessionOutput(cwd, sessionId);
        } catch {
          // Live output is non-critical — engine continues without it
        }
      }
    });
    await follower?.stop();
    console.log(`Status: ${result.session.status}`);
    console.log(`Review: ${result.review.summary}`);
  } catch (error) {
    await follower?.stop();
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Engine error: ${msg}`);
    process.exitCode = 1;
  }
}
