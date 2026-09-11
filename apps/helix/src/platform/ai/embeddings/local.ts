import type { MemoryEmbeddingProvider } from "../memory/types.js";

/** Local fallback when the chat provider (Groq, etc.) has no embeddings API. */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

export function localEmbeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HELIX_LOCAL_EMBEDDINGS !== "false";
}

export function hashedEmbedding(
  text: string,
  dimensions = LOCAL_EMBEDDING_DIMENSIONS,
): readonly number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    addHash(vector, token, 1);
    if (token.length >= 3) {
      for (let index = 0; index <= token.length - 3; index += 1)
        addHash(vector, token.slice(index, index + 3), 0.35);
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

export function createLocalEmbeddingProvider(): MemoryEmbeddingProvider {
  return {
    async embed(texts) {
      return texts.map((text) => hashedEmbedding(text));
    },
  };
}

function addHash(vector: number[], token: string, weight: number): void {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1)
    hash = Math.imul(hash ^ token.charCodeAt(index), 16_777_619);
  const bucket = (hash >>> 0) % vector.length;
  vector[bucket] = (vector[bucket] ?? 0) + weight;
}
