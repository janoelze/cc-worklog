import OpenAI from "openai";
import type { ParsedSession, SessionSummary } from "./types.js";
import { buildTranscript, buildMinimalTranscript } from "./parser.js";
import {
  countTokens,
  exceedsTokenLimit,
  splitIntoChunks,
  TOKEN_LIMITS,
} from "./tokenizer.js";

const SYSTEM_PROMPT = `You are analyzing a Claude Code session transcript. Extract a concise summary.

Output JSON:
{
  "title": "Short title (5-8 words)",
  "summary": "2-3 sentence summary of what was accomplished",
  "whatWasDone": ["List of actions taken"],
  "filesChanged": [{"path": "...", "change": "brief description"}],
  "decisions": [{"decision": "...", "reasoning": "..."}],
  "errors": ["Errors encountered and how resolved"],
  "commands": ["Notable commands run"]
}

Focus on:
- What the user wanted to accomplish
- Key decisions and their reasoning
- Problems encountered and solutions
- Outcomes and results

Keep it concise. Skip empty arrays.`;

const MAP_SYSTEM_PROMPT = `You are analyzing a PORTION of a Claude Code session transcript.
Extract partial findings from this chunk. This is chunk {chunkNum} of {totalChunks}.

Output JSON:
{
  "whatWasDone": ["Actions taken in this portion"],
  "filesChanged": [{"path": "...", "change": "brief description"}],
  "decisions": [{"decision": "...", "reasoning": "..."}],
  "errors": ["Errors encountered"],
  "commands": ["Commands run"]
}

Only include information present in this chunk. Be concise.`;

const REDUCE_SYSTEM_PROMPT = `You are combining partial summaries from different chunks of a Claude Code session.
Merge these into a single coherent summary. Remove duplicates and resolve contradictions.

Output JSON:
{
  "title": "Short title (5-8 words)",
  "summary": "2-3 sentence summary of what was accomplished overall",
  "whatWasDone": ["Combined list of actions taken"],
  "filesChanged": [{"path": "...", "change": "brief description"}],
  "decisions": [{"decision": "...", "reasoning": "..."}],
  "errors": ["Errors encountered and how resolved"],
  "commands": ["Notable commands run"]
}

Deduplicate file changes. Synthesize the overall narrative.`;

// Initialize OpenAI client (uses OPENAI_API_KEY env var)
const client = new OpenAI();

interface PartialSummary {
  whatWasDone?: string[];
  filesChanged?: { path: string; change: string }[];
  decisions?: { decision: string; reasoning: string }[];
  errors?: string[];
  commands?: string[];
}

/**
 * Call OpenAI API with given messages
 */
async function callOpenAI(
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in response");
  }
  return content;
}

/**
 * Summarize using single API call (for sessions that fit in context)
 */
async function summarizeSinglePass(transcript: string): Promise<SessionSummary> {
  const content = await callOpenAI(SYSTEM_PROMPT, transcript);
  const summary = JSON.parse(content) as SessionSummary;

  return {
    title: summary.title || "Untitled Session",
    summary: summary.summary || "",
    whatWasDone: summary.whatWasDone || [],
    filesChanged: summary.filesChanged || [],
    decisions: summary.decisions || [],
    errors: summary.errors || [],
    commands: summary.commands || [],
  };
}

/**
 * Summarize using map-reduce for very long sessions
 */
async function summarizeMapReduce(
  transcript: string,
  session: ParsedSession
): Promise<SessionSummary> {
  const chunks = splitIntoChunks(transcript);
  console.log(`    (map-reduce: ${chunks.length} chunks)`);

  // MAP phase: summarize each chunk in parallel
  const mapPromises = chunks.map(async (chunk, i) => {
    const systemPrompt = MAP_SYSTEM_PROMPT.replace("{chunkNum}", String(i + 1)).replace(
      "{totalChunks}",
      String(chunks.length)
    );

    try {
      const content = await callOpenAI(systemPrompt, chunk);
      return JSON.parse(content) as PartialSummary;
    } catch {
      return {} as PartialSummary;
    }
  });

  const partialSummaries = await Promise.all(mapPromises);

  // REDUCE phase: combine partial summaries
  const combinedPartials = JSON.stringify(
    {
      project: session.project,
      date: session.startTime.toISOString().split("T")[0],
      partialSummaries,
    },
    null,
    2
  );

  const reduceContent = await callOpenAI(REDUCE_SYSTEM_PROMPT, combinedPartials);
  const finalSummary = JSON.parse(reduceContent) as SessionSummary;

  return {
    title: finalSummary.title || "Untitled Session",
    summary: finalSummary.summary || "",
    whatWasDone: finalSummary.whatWasDone || [],
    filesChanged: finalSummary.filesChanged || [],
    decisions: finalSummary.decisions || [],
    errors: finalSummary.errors || [],
    commands: finalSummary.commands || [],
  };
}

/**
 * Summarize a parsed session using OpenAI API
 * Automatically handles long sessions with map-reduce
 */
export async function summarizeSession(
  session: ParsedSession
): Promise<SessionSummary> {
  // Build transcript with aggressive filtering
  let transcript = buildTranscript(session);
  let tokenCount = countTokens(transcript);

  console.log(`    (${tokenCount} tokens)`);

  // If still too long, try minimal transcript
  if (exceedsTokenLimit(transcript)) {
    console.log(`    (exceeds limit, using minimal transcript)`);
    transcript = buildMinimalTranscript(session);
    tokenCount = countTokens(transcript);
    console.log(`    (minimal: ${tokenCount} tokens)`);
  }

  // If still too long, use map-reduce on original transcript
  if (exceedsTokenLimit(transcript)) {
    console.log(`    (still too long, using map-reduce)`);
    const fullTranscript = buildTranscript(session, {
      maxAssistantLength: 200,
      maxConversationTurns: 100,
    });
    return summarizeMapReduce(fullTranscript, session);
  }

  try {
    return await summarizeSinglePass(transcript);
  } catch (error) {
    // Fallback if API call or parsing fails
    console.error("Summarization failed:", (error as Error).message);
    return {
      title: "Session Summary",
      summary: `Session in ${session.projectSlug} with ${session.prompts.length} prompts.`,
      whatWasDone: session.prompts.map((p) => p.text.slice(0, 100)),
      filesChanged: session.filesEdited.map((f) => ({
        path: f.path,
        change: "edited",
      })),
      decisions: [],
      errors: [],
      commands: session.commandsRun.map((c) => c.command.slice(0, 100)),
    };
  }
}
