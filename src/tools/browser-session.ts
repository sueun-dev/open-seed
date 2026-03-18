import fs from "node:fs/promises";
import path from "node:path";

import { getBrowserCheckpointDir, getBrowserDir } from "../core/paths.js";
import type { BrowserCheckpoint } from "../core/types.js";
import { createId, ensureDir, fileExists, nowIso } from "../core/utils.js";

export interface BrowserSessionPaths {
  browserDir: string;
  checkpointDir: string;
  statePath: string;
  latestPath: string;
}

export function getBrowserSessionPaths(cwd: string, localDirName: string, sessionId: string, sessionName: string): BrowserSessionPaths {
  const safeName = sanitizeSessionName(sessionName);
  const browserDir = getBrowserDir(cwd, localDirName);
  return {
    browserDir,
    checkpointDir: getBrowserCheckpointDir(cwd, localDirName),
    statePath: path.join(browserDir, `${sessionId}-${safeName}-storage.json`),
    latestPath: path.join(browserDir, `${sessionId}-${safeName}-latest.json`)
  };
}

export async function readLatestBrowserCheckpoint(cwd: string, localDirName: string, sessionId: string, sessionName: string): Promise<BrowserCheckpoint | null> {
  const { latestPath } = getBrowserSessionPaths(cwd, localDirName, sessionId, sessionName);
  if (!(await fileExists(latestPath))) {
    return null;
  }
  return JSON.parse(await fs.readFile(latestPath, "utf8")) as BrowserCheckpoint;
}

export async function listLatestBrowserCheckpoints(cwd: string, localDirName: string, sessionId: string): Promise<BrowserCheckpoint[]> {
  const browserDir = getBrowserDir(cwd, localDirName);
  if (!(await fileExists(browserDir))) {
    return [];
  }

  const entries = await fs.readdir(browserDir);
  const checkpoints = await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${sessionId}-`) && entry.endsWith("-latest.json"))
      .map(async (entry) => JSON.parse(await fs.readFile(path.join(browserDir, entry), "utf8")) as BrowserCheckpoint)
  );

  return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function writeBrowserCheckpoint(params: {
  cwd: string;
  localDirName: string;
  sessionId: string;
  sessionName: string;
  action: string;
  url: string;
  title: string;
  screenshotPath?: string;
  consoleMessages?: string[];
  requests?: string[];
}): Promise<BrowserCheckpoint> {
  const paths = getBrowserSessionPaths(params.cwd, params.localDirName, params.sessionId, params.sessionName);
  await ensureDir(paths.browserDir);
  await ensureDir(paths.checkpointDir);

  const checkpoint: BrowserCheckpoint = {
    id: createId("browser"),
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    action: params.action,
    url: params.url,
    title: params.title,
    createdAt: nowIso(),
    screenshotPath: params.screenshotPath,
    consoleMessages: params.consoleMessages,
    requests: params.requests
  };

  const checkpointPath = path.join(paths.checkpointDir, `${checkpoint.id}.json`);
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
  await fs.writeFile(paths.latestPath, JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpoint;
}

function sanitizeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
