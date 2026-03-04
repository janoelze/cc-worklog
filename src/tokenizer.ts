import { encode } from "gpt-tokenizer/model/gpt-4o";

// Token budget configuration
export const TOKEN_LIMITS = {
  // GPT-4o-mini has 128K context, leave room for output + system prompt
  MAX_INPUT_TOKENS: 100_000,
  // Target chunk size for map-reduce
  CHUNK_TARGET_TOKENS: 30_000,
  // Overlap between chunks (last user prompt context)
  CHUNK_OVERLAP_TOKENS: 1_000,
};

/**
 * Count tokens in a string using GPT-4o tokenizer
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Truncate text to fit within token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) {
    return text;
  }

  // Binary search for the right character cutoff
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const truncated = text.slice(0, mid);
    if (encode(truncated).length <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low) + "...";
}

/**
 * Check if text exceeds the token limit
 */
export function exceedsTokenLimit(text: string): boolean {
  return countTokens(text) > TOKEN_LIMITS.MAX_INPUT_TOKENS;
}

/**
 * Split text into chunks for map-reduce processing
 * Tries to split at semantic boundaries (double newlines)
 */
export function splitIntoChunks(text: string): string[] {
  const totalTokens = countTokens(text);

  if (totalTokens <= TOKEN_LIMITS.MAX_INPUT_TOKENS) {
    return [text];
  }

  const chunks: string[] = [];
  const sections = text.split(/\n\n+/);
  let currentChunk = "";
  let currentTokens = 0;

  for (const section of sections) {
    const sectionTokens = countTokens(section);

    if (
      currentTokens + sectionTokens >
      TOKEN_LIMITS.CHUNK_TARGET_TOKENS
    ) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = section;
      currentTokens = sectionTokens;
    } else {
      currentChunk += "\n\n" + section;
      currentTokens += sectionTokens;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
