import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SessionInfo, State } from "./types.js";
import { detectProjectName, slugifyProjectName } from "./project-name.js";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

// Cache for project name detection (avoid repeated fs reads)
const projectNameCache = new Map<string, { name: string; slug: string; source: string }>();

/**
 * Decode project path from directory name
 * e.g., "-Users-jane-src-myapp" -> "/Users/jane/src/myapp"
 */
function decodeProjectPath(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Get project name with caching
 */
async function getProjectName(projectPath: string): Promise<{ name: string; slug: string; source: string }> {
  if (projectNameCache.has(projectPath)) {
    return projectNameCache.get(projectPath)!;
  }

  const detected = await detectProjectName(projectPath);
  const result = {
    name: detected.name,
    slug: slugifyProjectName(detected.name),
    source: detected.source,
  };

  projectNameCache.set(projectPath, result);
  return result;
}

/**
 * Check if a file is a main session log (not an agent subprocess)
 */
function isMainSessionLog(filename: string): boolean {
  return filename.endsWith(".jsonl") && !filename.startsWith("agent-");
}

/**
 * Extract session ID from filename
 * e.g., "49d6e4a2-5d0f-4b4d-bf72-1e03272501db.jsonl" -> "49d6e4a2-5d0f-4b4d-bf72-1e03272501db"
 */
function extractSessionId(filename: string): string {
  return filename.replace(".jsonl", "");
}

/**
 * Discover all sessions from Claude Code's project directories
 */
export async function discoverSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  try {
    const projectDirs = await readdir(PROJECTS_DIR);

    for (const projectDir of projectDirs) {
      const projectPath = join(PROJECTS_DIR, projectDir);
      const projectStat = await stat(projectPath);

      if (!projectStat.isDirectory()) continue;

      const files = await readdir(projectPath);

      for (const file of files) {
        if (!isMainSessionLog(file)) continue;

        const logFile = join(projectPath, file);
        const fileStat = await stat(logFile);
        const project = decodeProjectPath(projectDir);
        const projectInfo = await getProjectName(project);

        sessions.push({
          sessionId: extractSessionId(file),
          project,
          projectName: projectInfo.name,
          projectSlug: projectInfo.slug,
          projectNameSource: projectInfo.source as SessionInfo["projectNameSource"],
          logFile,
          startTime: fileStat.birthtime,
        });
      }
    }
  } catch (error) {
    // Projects directory might not exist yet
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Sort by start time, newest first
  return sessions.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
}

/**
 * Filter sessions to only unprocessed ones
 */
export function getUnprocessedSessions(
  sessions: SessionInfo[],
  state: State
): SessionInfo[] {
  return sessions.filter((session) => !state.processed[session.sessionId]);
}

/**
 * Check if a session is closed (no modifications for 1 hour)
 */
export async function isSessionClosed(logFile: string): Promise<boolean> {
  const fileStat = await stat(logFile);
  const mtime = fileStat.mtimeMs;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return mtime < oneHourAgo;
}
