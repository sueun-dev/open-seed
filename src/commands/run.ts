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
        follower = await attachLiveSessionOutput(cwd, sessionId);
      }
    });
    await follower?.stop();
    console.log(`Status: ${result.session.status}`);
    console.log(`Review: ${result.review.summary}`);
  } finally {
    await follower?.stop();
  }
}
