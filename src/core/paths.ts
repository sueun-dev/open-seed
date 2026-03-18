import os from "node:os";
import path from "node:path";

export function getProjectAgentDir(cwd: string, localDirName = ".agent"): string {
  return path.join(cwd, localDirName);
}

export function getGlobalAgentDir(namespace = "agent40"): string {
  return path.join(os.homedir(), ".config", namespace);
}

export function getSessionsDir(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "sessions");
}

export function getTasksDir(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "tasks");
}

export function getRepoMapPath(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "repo-map.json");
}

export function getConfigPath(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "config.json");
}

export function getBrowserDir(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "browser");
}

export function getBrowserCheckpointDir(cwd: string, localDirName = ".agent"): string {
  return path.join(getBrowserDir(cwd, localDirName), "checkpoints");
}

export function getSoakDir(cwd: string, localDirName = ".agent"): string {
  return path.join(getProjectAgentDir(cwd, localDirName), "soak");
}

export function getGlobalIndexPath(namespace = "agent40"): string {
  return path.join(getGlobalAgentDir(namespace), "sessions.json");
}
