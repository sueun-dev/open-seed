import { attachLiveSessionOutput } from "./live-session.js";
import { runEngine } from "../orchestration/engine.js";

export async function runRunCommand(task: string): Promise<void> {
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
