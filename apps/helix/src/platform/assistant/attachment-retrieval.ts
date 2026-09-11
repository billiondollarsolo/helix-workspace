import { chunkDocument, retrievalChunkSettings } from "../search/chunks.js";
import { assistantContextLimits } from "./context-policy.js";
import type { AssistantSource } from "./types.js";

const maxChunksPerFile = 96;
const embedBatch = 32;

export type AttachmentEmbed = (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const n = Math.min(left.length, right.length);
  let dot = 0,
    leftNorm = 0,
    rightNorm = 0;
  for (let index = 0; index < n; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

function lastUserQuery(history: readonly { readonly role: string; readonly content: string }[]) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

async function embedAll(
  texts: readonly string[],
  embed: AttachmentEmbed,
): Promise<readonly (readonly number[])[]> {
  const vectors: (readonly number[])[] = [];
  for (let offset = 0; offset < texts.length; offset += embedBatch) {
    const batch = texts.slice(offset, offset + embedBatch);
    const result = await embed(batch);
    if (result.length !== batch.length)
      throw new TypeError("Embedding response count does not match inputs.");
    vectors.push(...result);
  }
  return vectors;
}

async function retrieveBody(
  source: AssistantSource,
  query: string,
  queryVector: readonly number[] | undefined,
  embed: AttachmentEmbed | undefined,
  chunking: { readonly size: number; readonly overlap: number },
  limit: number,
): Promise<string> {
  const body = source.body ?? "";
  if (body.length === 0 || body.length <= limit) return body;
  if (embed === undefined || queryVector === undefined || query.trim().length === 0)
    return excerpt(body, limit);
  const chunks = chunkDocument(
    { id: source.id, type: source.type, title: source.title, body },
    chunking,
  ).slice(0, maxChunksPerFile);
  if (chunks.length === 0) return excerpt(body, limit);
  const vectors = await embedAll(
    chunks.map((chunk) => chunk.text),
    embed,
  );
  const ranked = chunks
    .map((chunk, index) => ({
      text: chunk.text,
      score: cosineSimilarity(queryVector, vectors[index] ?? []),
    }))
    .sort((left, right) => right.score - left.score);
  const selected: string[] = [];
  let remaining = limit;
  for (const chunk of ranked) {
    if (remaining <= 0) break;
    if (chunk.score <= 0 && selected.length > 0) break;
    const text = excerpt(chunk.text, remaining);
    selected.push(text);
    remaining -= text.length;
  }
  return selected.join("\n") || excerpt(body, limit);
}

/** Prompt-facing sources: relevant attachment passages, not the whole file. Full bodies stay on the turn for context.view. */
export async function sourcesForPrompt(
  sources: readonly AssistantSource[],
  history: readonly { readonly role: string; readonly content: string }[],
  embed?: AttachmentEmbed,
): Promise<readonly AssistantSource[]> {
  const query = lastUserQuery(history);
  const chunking = retrievalChunkSettings();
  let queryVector: readonly number[] | undefined;
  if (embed !== undefined && query.trim().length > 0) {
    try {
      queryVector = (await embed([query]))[0];
    } catch {
      queryVector = undefined;
    }
  }
  const prepared: AssistantSource[] = [];
  let remaining: number = assistantContextLimits.totalSourceCharacters;
  for (const source of sources) {
    if (remaining <= 0) break;
    const limit = Math.min(assistantContextLimits.sourceCharacters, remaining);
    let body = source.body ?? "";
    if (source.type === "drive.attachment" && body.length > limit) {
      try {
        body = await retrieveBody(source, query, queryVector, embed, chunking, limit);
      } catch {
        body = excerpt(body, limit);
      }
    } else if (body.length > limit) body = excerpt(body, limit);
    remaining -= body.length;
    prepared.push(body === source.body ? source : { ...source, body });
  }
  return prepared;
}
