import { readFile } from "fs/promises";
import type {
  SessionInfo,
  ParsedSession,
  Prompt,
  FileRead,
  FileEdit,
  Command,
  ErrorInfo,
  ConversationTurn,
} from "./types.js";

interface JsonlMessage {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }>;
  };
  tool?: string;
  input?: Record<string, unknown>;
  content?: string;
}

/**
 * Extract text content from a message
 */
function extractTextContent(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

/**
 * Parse a Claude Code session JSONL file
 */
export async function parseSession(
  sessionInfo: SessionInfo
): Promise<ParsedSession> {
  const content = await readFile(sessionInfo.logFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const prompts: Prompt[] = [];
  const filesRead: FileRead[] = [];
  const filesEdited: FileEdit[] = [];
  const commandsRun: Command[] = [];
  const errors: ErrorInfo[] = [];
  const conversation: ConversationTurn[] = [];

  let startTime: Date | null = null;
  let endTime: Date | null = null;

  for (const line of lines) {
    try {
      const msg: JsonlMessage = JSON.parse(line);
      const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();

      // Track time bounds
      if (!startTime || timestamp < startTime) startTime = timestamp;
      if (!endTime || timestamp > endTime) endTime = timestamp;

      switch (msg.type) {
        case "user":
          if (msg.message?.content) {
            const text = extractTextContent(msg.message.content);
            prompts.push({ text, timestamp });
            conversation.push({ role: "user", content: text, timestamp });
          }
          break;

        case "assistant":
          if (msg.message?.content) {
            const text = extractTextContent(msg.message.content);
            conversation.push({ role: "assistant", content: text, timestamp });
          }
          break;

        case "tool_use":
          if (msg.tool === "Read" && msg.input?.file_path) {
            filesRead.push({
              path: msg.input.file_path as string,
              timestamp,
            });
          } else if (msg.tool === "Edit" && msg.input?.file_path) {
            filesEdited.push({
              path: msg.input.file_path as string,
              oldString: msg.input.old_string as string | undefined,
              newString: msg.input.new_string as string | undefined,
              timestamp,
            });
          } else if (msg.tool === "Write" && msg.input?.file_path) {
            filesEdited.push({
              path: msg.input.file_path as string,
              timestamp,
            });
          } else if (msg.tool === "Bash" && msg.input?.command) {
            commandsRun.push({
              command: msg.input.command as string,
              timestamp,
            });
          }
          break;

        case "tool_result":
          // Check for errors in tool results
          if (
            msg.content &&
            (msg.content.includes("Error") || msg.content.includes("error"))
          ) {
            errors.push({
              message: msg.content.slice(0, 500),
              timestamp,
            });
          }
          break;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    sessionId: sessionInfo.sessionId,
    project: sessionInfo.project,
    projectName: sessionInfo.projectName,
    projectSlug: sessionInfo.projectSlug,
    startTime: startTime || sessionInfo.startTime,
    endTime: endTime || new Date(),
    prompts,
    filesRead,
    filesEdited,
    commandsRun,
    errors,
    conversation,
  };
}

/**
 * Build a condensed transcript string for AI summarization
 * Applies aggressive filtering to minimize token usage
 */
export function buildTranscript(
  session: ParsedSession,
  options: { maxAssistantLength?: number; maxConversationTurns?: number } = {}
): string {
  const { maxAssistantLength = 300, maxConversationTurns = 50 } = options;

  const lines: string[] = [];

  lines.push("=== SESSION TRANSCRIPT ===");
  lines.push(`Project: ${session.project}`);
  lines.push(`Date: ${session.startTime.toISOString().split("T")[0]}`);
  lines.push("");

  // User prompts - keep full text (most important)
  lines.push("## User Requests");
  for (const prompt of session.prompts) {
    lines.push(`[${prompt.timestamp.toISOString()}]`);
    lines.push(prompt.text);
    lines.push("");
  }

  // Files edited - with change summary
  if (session.filesEdited.length > 0) {
    lines.push("## Files Edited");
    const editsByFile = new Map<string, FileEdit[]>();
    for (const edit of session.filesEdited) {
      const existing = editsByFile.get(edit.path) || [];
      existing.push(edit);
      editsByFile.set(edit.path, existing);
    }
    for (const [path, edits] of editsByFile) {
      lines.push(`- ${path} (${edits.length} edit${edits.length > 1 ? "s" : ""})`);
    }
    lines.push("");
  }

  // Files read - deduplicated, path only
  const filesReadOnly = new Set(session.filesRead.map((f) => f.path));
  for (const editedPath of session.filesEdited.map((f) => f.path)) {
    filesReadOnly.delete(editedPath);
  }
  if (filesReadOnly.size > 0) {
    lines.push("## Files Read");
    for (const path of filesReadOnly) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  // Errors - important for understanding what went wrong
  if (session.errors.length > 0) {
    lines.push("## Errors Encountered");
    const uniqueErrors = [...new Set(session.errors.map((e) => e.message.slice(0, 200)))];
    for (const error of uniqueErrors.slice(0, 10)) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  // Commands run - without output
  if (session.commandsRun.length > 0) {
    lines.push("## Commands Run");
    const uniqueCommands = [...new Set(session.commandsRun.map((c) => c.command.slice(0, 150)))];
    for (const cmd of uniqueCommands.slice(0, 15)) {
      lines.push(`- ${cmd}`);
    }
    lines.push("");
  }

  // Conversation - user prompts full, assistant truncated
  lines.push("## Conversation Flow");
  const conversationToInclude = session.conversation.slice(0, maxConversationTurns);
  for (const turn of conversationToInclude) {
    if (turn.role === "user") {
      lines.push(`User: ${turn.content}`);
    } else {
      // Truncate assistant responses more aggressively
      const truncated =
        turn.content.length > maxAssistantLength
          ? turn.content.slice(0, maxAssistantLength) + "..."
          : turn.content;
      lines.push(`Assistant: ${truncated}`);
    }
    lines.push("");
  }

  lines.push("=== END TRANSCRIPT ===");

  return lines.join("\n");
}

/**
 * Build a minimal transcript for very long sessions
 * Only includes essential information
 */
export function buildMinimalTranscript(session: ParsedSession): string {
  const lines: string[] = [];

  lines.push("=== SESSION SUMMARY ===");
  lines.push(`Project: ${session.project}`);
  lines.push(`Date: ${session.startTime.toISOString().split("T")[0]}`);
  lines.push(`Duration: ${Math.round((session.endTime.getTime() - session.startTime.getTime()) / 60000)} minutes`);
  lines.push("");

  // Only user prompts
  lines.push("## User Requests");
  for (const prompt of session.prompts) {
    lines.push(`- ${prompt.text.slice(0, 500)}`);
  }
  lines.push("");

  // Only edited files
  if (session.filesEdited.length > 0) {
    lines.push("## Files Modified");
    const uniqueEdited = [...new Set(session.filesEdited.map((f) => f.path))];
    for (const path of uniqueEdited) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  // Key errors only
  if (session.errors.length > 0) {
    lines.push("## Errors");
    const uniqueErrors = [...new Set(session.errors.map((e) => e.message.slice(0, 100)))];
    for (const error of uniqueErrors.slice(0, 5)) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  lines.push("=== END ===");

  return lines.join("\n");
}
