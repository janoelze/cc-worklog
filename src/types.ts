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
}

// State management
export interface ProcessedSession {
  processedAt: string;
  outputFile: string;
}

export interface FailedSession {
  attempts: number;
  lastAttempt: string;
  lastError: string;
  canRetryAfter?: string;
}

export interface RetryingSession {
  attempts: number;
  lastAttempt: string;
  lastError: string;
  nextAttempt: string;
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailure?: string;
  cooldownUntil?: string;
}

export interface DaemonState {
  startedAt: string;
  lastCheck: string;
  sessionsProcessed: number;
  errors: number;
  circuitBreaker: CircuitBreakerState;
}

export interface State {
  processed: Record<string, ProcessedSession>;
  failed?: Record<string, FailedSession>;
  retrying?: Record<string, RetryingSession>;
  daemon?: DaemonState;
}

// Daemon configuration
export interface DaemonConfig {
  pollInterval: number;       // ms, default 60000
  sessionTimeout: number;     // ms, default 3600000 (1 hour)
  logFile: string;
  pidFile: string;
  healthFile: string;
  maxRetries: number;         // per session, default 3
  circuitBreaker: {
    failureThreshold: number; // default 5
    cooldownInitial: number;  // ms, default 60000
    cooldownMax: number;      // ms, default 1800000 (30min)
  };
  backoff: {
    initialDelay: number;     // ms, default 1000
    maxDelay: number;         // ms, default 300000 (5min)
    multiplier: number;       // default 2
    jitter: number;           // default 0.3
  };
}
