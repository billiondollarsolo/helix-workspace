import { env } from "../config/env.js";
import { createMeilisearchHttpClient, MeilisearchSearchEngine } from "../platform/search/index.js";
import { regionalResourceName } from "../platform/tenancy/index.js";

export async function createSearchEngine(
  region: string,
): Promise<MeilisearchSearchEngine | undefined> {
  const searchEnv = env();
  const baseUrl = searchEnv.MEILI_URL ?? searchEnv.MEILISEARCH_URL ?? searchEnv.MEILI_HOST;
  if (baseUrl === undefined) {
    return undefined;
  }
  const apiKey =
    searchEnv.MEILI_MASTER_KEY ?? searchEnv.MEILI_API_KEY ?? searchEnv.MEILISEARCH_API_KEY;
  const engine = new MeilisearchSearchEngine(
    createMeilisearchHttpClient({
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    {
      indexUid:
        searchEnv.MEILI_INDEX_UID ??
        searchEnv.MEILISEARCH_INDEX_UID ??
        regionalResourceName(region, "helix_search"),
    },
  );
  await engine.ensureIndex();
  return engine;
}
