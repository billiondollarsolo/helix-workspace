import { createMeilisearchHttpClient } from "./meilisearch-http.js";
import { MeilisearchSearchEngine } from "./meilisearch.js";
import type { SearchEngine } from "./types.js";

export interface SearchEngineEnv {
  readonly MEILI_URL?: string | undefined;
  readonly MEILISEARCH_URL?: string | undefined;
  readonly MEILI_HOST?: string | undefined;
  readonly MEILI_MASTER_KEY?: string | undefined;
  readonly MEILI_API_KEY?: string | undefined;
  readonly MEILISEARCH_API_KEY?: string | undefined;
  readonly MEILI_INDEX_UID?: string | undefined;
  readonly MEILISEARCH_INDEX_UID?: string | undefined;
}

export async function createMeilisearchSearchEngineFromEnv(
  env: SearchEngineEnv = process.env,
): Promise<SearchEngine | undefined> {
  const baseUrl = env.MEILI_URL ?? env.MEILISEARCH_URL ?? env.MEILI_HOST;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return undefined;
  }
  const apiKey = env.MEILI_MASTER_KEY ?? env.MEILI_API_KEY ?? env.MEILISEARCH_API_KEY;
  const engine = new MeilisearchSearchEngine(
    createMeilisearchHttpClient({
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    {
      indexUid: env.MEILI_INDEX_UID ?? env.MEILISEARCH_INDEX_UID ?? "helix_search",
    },
  );
  await engine.ensureIndex();
  return engine;
}
