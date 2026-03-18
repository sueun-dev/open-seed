import { loadConfig } from "../core/config.js";
import { formatSessionActivity, summarizeSessionActivity } from "../sessions/activity.js";
import { SessionStore } from "../sessions/store.js";
import { listLatestBrowserCheckpoints } from "../tools/browser-session.js";

export async function runStatusCommand(sessionId?: string): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const store = new SessionStore(cwd, config.sessions);

  if (!sessionId) {
    const sessions = await store.listSessions(cwd);
    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }
    for (const session of sessions) {
      console.log(`${session.id}  ${session.status}  ${session.updatedAt}  ${session.task}`);
    }
    return;
  }

  const snapshot = await store.loadSnapshot(sessionId);
  if (!snapshot) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const events = await store.readEvents(sessionId);
  const browserCheckpoints = await listLatestBrowserCheckpoints(cwd, config.sessions.localDirName, sessionId);
  console.log(formatSessionActivity(summarizeSessionActivity(snapshot, events, browserCheckpoints)));
}
