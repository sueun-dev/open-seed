import { loadConfig } from "../core/config.js";
import { SessionStore } from "../sessions/store.js";
import { runEngine } from "../orchestration/engine.js";
import { attachLiveSessionOutput } from "./live-session.js";

export async function runResumeCommand(sessionId: string): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const store = new SessionStore(cwd, config.sessions);
  const existing = await store.loadSnapshot(sessionId);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  let follower: Awaited<ReturnType<typeof attachLiveSessionOutput>> | undefined;

  try {
    const result = await runEngine({
      cwd,
      task: existing.task,
      mode: "run",
      resumeSessionId: sessionId,
      async onSessionReady(readySessionId) {
        follower = await attachLiveSessionOutput(cwd, readySessionId, false);
      }
    });
    await follower?.stop();
    console.log(`Status: ${result.session.status}`);
    console.log(`Review: ${result.review.summary}`);
  } finally {
    await follower?.stop();
  }
}
