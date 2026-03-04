// Session discovery types
export interface SessionInfo {
  sessionId: string;
  project: string;
  projectName: string;
  projectSlug: string;
  projectNameSource: "package.json" | "git-remote" | "pyproject.toml" | "cargo.toml" | "go.mod" | "directory" | "path-segment";
  logFile: string;
  startTime: Date;
}

// Parsed session types
export interface Prompt {
  text: string;
  timestamp: Date;
}

export interface FileRead {
  path: string;
  timestamp: Date;
}

export interface FileEdit {
  path: string;
  oldString?: string;
  newString?: string;
  timestamp: Date;
}

export interface Command {
  command: string;
  output?: string;
  exitCode?: number;
  timestamp: Date;
}

export interface ErrorInfo {
  message: string;
  context?: string;
  timestamp: Date;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface ParsedSession {
  sessionId: string;
  project: string;
  projectName: string;
  projectSlug: string;
  startTime: Date;
  endTime: Date;
  prompts: Prompt[];
  filesRead: FileRead[];
  filesEdited: FileEdit[];
  commandsRun: Command[];
  errors: ErrorInfo[];
  conversation: ConversationTurn[];
}

// Summary types
export interface FileChange {
  path: string;
  change: string;
}

export interface Decision {
  decision: string;
  reasoning: string;
}

export interface SessionSummary {
  title: string;
  summary: string;
  whatWasDone: string[];
  filesChanged: FileChange[];
  decisions: Decision[];
  errors: string[];
  commands: string[];
}

// State management
export interface ProcessedSession {
  processedAt: string;
  outputFile: string;
}

export interface State {
  processed: Record<string, ProcessedSession>;
  daemon?: {
    startedAt: string;
    lastCheck: string;
    sessionsProcessed: number;
  };
}
