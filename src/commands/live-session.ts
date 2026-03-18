import { loadConfig } from "../core/config.js";
import { followSessionEvents, formatLiveEvent, type SessionFollower } from "../sessions/follow.js";

export async function attachLiveSessionOutput(cwd: string, sessionId: string, fromStart = true): Promise<SessionFollower> {
  const config = await loadConfig(cwd);
  console.log(`Session: ${sessionId}`);
  return followSessionEvents({
    cwd,
    config: config.sessions,
    sessionId,
    fromStart,
    onEvent(event) {
      const line = formatLiveEvent(event);
      if (line) {
        console.log(line);
      }
    }
  });
}
