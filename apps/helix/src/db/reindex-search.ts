import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import {
  createMeilisearchSearchEngineFromEnv,
  createPostgresSearchReindexSources,
  SearchReindexService,
  searchReindexTypes,
  type SearchReindexRequest,
  type SearchReindexResult,
  type SearchReindexType,
} from "../platform/search/index.js";

export interface ReindexSearchCommandOptions extends SearchReindexRequest {
  readonly requireAll?: boolean | undefined;
}

export interface ReindexSearchCommandResult extends SearchReindexResult {
  readonly searchConfigured: true;
}

export type ReindexSearchResult =
  | ReindexSearchCommandResult
  | { readonly searchConfigured: false; readonly totalDocuments: 0; readonly deletedDocuments: 0 };

export function parseReindexSearchArgs(args: readonly string[]): ReindexSearchCommandOptions {
  const options: {
    requireAll?: boolean | undefined;
    types?: readonly SearchReindexType[] | undefined;
    orgId?: string | undefined;
    batchSize?: number | undefined;
    pruneStale?: boolean | undefined;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--all":
        options.requireAll = true;
        break;
      case "--type":
      case "--types": {
        options.types = parseTypes(
          requireOptionValue(args, index, `${arg} requires a comma-separated type list`),
        );
        index += 1;
        break;
      }
      case "--org-id": {
        options.orgId = requireOptionValue(args, index, "--org-id requires an org UUID");
        index += 1;
        break;
      }
      case "--batch-size": {
        options.batchSize = parsePositiveInteger(
          requireOptionValue(args, index, "--batch-size requires a positive integer"),
          "--batch-size",
        );
        index += 1;
        break;
      }
      case "--no-prune-stale":
        options.pruneStale = false;
        break;
      case "-h":
      case "--help":
        throw new Error(usage);
      default:
        throw new Error(`Unknown option: ${arg ?? ""}\n${usage}`);
    }
  }
  if (options.requireAll !== true && (options.types === undefined || options.types.length === 0)) {
    throw new Error(`Specify --all or --types <${searchReindexTypes.join("|")}>\n${usage}`);
  }
  return options;
}

export async function reindexSearch(
  sql: postgres.Sql,
  options: ReindexSearchCommandOptions,
): Promise<ReindexSearchResult> {
  const engine = await createMeilisearchSearchEngineFromEnv();
  if (engine === undefined) {
    return { searchConfigured: false, totalDocuments: 0, deletedDocuments: 0 };
  }

  const service = new SearchReindexService({
    engine,
    sources: createPostgresSearchReindexSources(sql),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
  const result = await service.reindex({
    ...(options.types === undefined ? {} : { types: options.types }),
    ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.pruneStale === undefined ? {} : { pruneStale: options.pruneStale }),
  });
  return { searchConfigured: true, ...result };
}

const usage = `Usage: pnpm --filter @helix/app db:reindex:search -- --all [--type <mail,chat,docs,drive,calendar>] [--org-id <uuid>] [--batch-size <n>] [--no-prune-stale]`;

/**
 * Read the value that follows a flag. A missing value, or the next flag, is
 * rejected so `--org-id --all` cannot silently consume `--all` as an org id.
 */
function requireOptionValue(args: readonly string[], index: number, message: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(message);
  }
  return value;
}

function parseTypes(value: string): readonly SearchReindexType[] {
  const types = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const allowed = new Set<string>(searchReindexTypes);
  for (const type of types) {
    if (!allowed.has(type)) {
      throw new Error(`Unsupported search reindex type: ${type}`);
    }
  }
  return types as readonly SearchReindexType[];
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  let options: ReindexSearchCommandOptions;
  try {
    options = parseReindexSearchArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const sql = createSqlClient();
  try {
    const result = await reindexSearch(sql, options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
