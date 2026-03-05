import OpenAI from "openai";
import type { ParsedSession, SessionSummary } from "./types.js";
import { buildTranscript, buildMinimalTranscript } from "./parser.js";
import {
  countTokens,
  exceedsTokenLimit,
  splitIntoChunks,
  TOKEN_LIMITS,
} from "./tokenizer.js";
import { getConfig } from "./config.js";

let openaiClient: OpenAI | null = null;

/**
 * Get or initialize the OpenAI client
 * Validates that API key is present before making any calls
 */
async function getOpenAIClient(): Promise<OpenAI> {
  if (openaiClient) {
    return openaiClient;
  }

  const config = await getConfig();
  const apiKey = config.openai.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set. Configure it with:\n" +
      "  export OPENAI_API_KEY=your-key\n" +
      "  # or\n" +
      "  cc-worklog config set openai.apiKey your-key"
    );
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

const SYSTEM_PROMPT = `You are analyzing a Claude Code session transcript. Extract a concise summary.

Output JSON:
{
  "title": "Short title (5-8 words)",
  "summary": "2-3 sentence summary of what was accomplished",
  "whatWasDone": ["List of actions taken"],
  "filesChanged": [{"path": "...", "change": "brief description"}],
  "decisions": [{"decision": "...", "reasoning": "..."}],
  "errors": ["Errors encountered and how resolved"]
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
  "errors": ["Errors encountered"]
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
  "errors": ["Errors encountered and how resolved"]
}

Deduplicate file changes. Synthesize the overall narrative.`;

interface PartialSummary {
  whatWasDone?: string[];
  filesChanged?: { path: string; change: string }[];
  decisions?: { decision: string; reasoning: string }[];
  errors?: string[];
}

/**
 * Call OpenAI API with given messages
 */
async function callOpenAI(
  systemPrompt: string,
  userContent: string,
  model: string
): Promise<string> {
  const client = await getOpenAIClient();

  const completion = await client.chat.completions.create({
    model,
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
 * Safely parse JSON response from OpenAI
 */
function parseJsonResponse<T>(content: string, context: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAI response (${context}): ${content.slice(0, 200)}...`
    );
  }
}

/**
 * Summarize using single API call (for sessions that fit in context)
 */
async function summarizeSinglePass(transcript: string, model: string): Promise<SessionSummary> {
  const content = await callOpenAI(SYSTEM_PROMPT, transcript, model);
  const summary = parseJsonResponse<SessionSummary>(content, "single-pass summary");

  return {
    title: summary.title || "Untitled Session",
    summary: summary.summary || "",
    whatWasDone: summary.whatWasDone || [],
    filesChanged: summary.filesChanged || [],
    decisions: summary.decisions || [],
    errors: summary.errors || [],
  };
}

/**
 * Summarize using map-reduce for very long sessions
 */
async function summarizeMapReduce(
  transcript: string,
  session: ParsedSession,
  model: string
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
      const content = await callOpenAI(systemPrompt, chunk, model);
      return parseJsonResponse<PartialSummary>(content, `map chunk ${i + 1}`);
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

  const reduceContent = await callOpenAI(REDUCE_SYSTEM_PROMPT, combinedPartials, model);
  const finalSummary = parseJsonResponse<SessionSummary>(reduceContent, "reduce summary");

  return {
    title: finalSummary.title || "Untitled Session",
    summary: finalSummary.summary || "",
    whatWasDone: finalSummary.whatWasDone || [],
    filesChanged: finalSummary.filesChanged || [],
    decisions: finalSummary.decisions || [],
    errors: finalSummary.errors || [],
  };
}

/**
 * Summarize a parsed session using OpenAI API
 * Automatically handles long sessions with map-reduce
 */
export async function summarizeSession(
  session: ParsedSession
): Promise<SessionSummary> {
  const config = await getConfig();
  const model = config.openai.model;

  // Build transcript with aggressive filtering
  let transcript = buildTranscript(session);
  let tokenCount = countTokens(transcript);

  console.log(`    (${tokenCount} tokens, model: ${model})`);

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
    return summarizeMapReduce(fullTranscript, session, model);
  }

  return await summarizeSinglePass(transcript, model);
}
