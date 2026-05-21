import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { runMigrations, type MigrationRunResult } from "./migration-runner.js";
import { reindexSearch, type ReindexSearchResult } from "./reindex-search.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";
import {
  DEFAULT_LOCAL_DEMO_VOLUME_MAIL_COUNT,
  seedLocalDemo,
  type SeedLocalDemoResult,
} from "./seed-local-demo.js";
import { verifyLocalDemo, type LocalDemoVerificationResult } from "./verify-local-demo.js";

export interface PrepareLocalDemoOptions {
  readonly migrate: boolean;
  readonly reindex: boolean;
  readonly verify: boolean;
  readonly requireStorage: boolean;
  readonly requireSearch: boolean;
  readonly batchSize?: number | undefined;
  readonly volumeSearch: boolean;
  readonly volumeMailMessages: number;
  readonly anchorDate?: string | undefined;
}

export interface PrepareLocalDemoResult {
  readonly ok: true;
  readonly migrations: MigrationRunResult | null;
  readonly seed: SeedLocalDemoResult;
  readonly reindex: ReindexSearchResult | null;
  readonly verification: LocalDemoVerificationResult | null;
}

const defaultOptions: PrepareLocalDemoOptions = {
  migrate: true,
  reindex: true,
  verify: true,
  requireStorage: false,
  requireSearch: false,
  volumeSearch: false,
  volumeMailMessages: DEFAULT_LOCAL_DEMO_VOLUME_MAIL_COUNT,
};

export function parsePrepareLocalDemoArgs(args: readonly string[]): PrepareLocalDemoOptions {
  const options: {
    migrate?: boolean | undefined;
    reindex?: boolean | undefined;
    verify?: boolean | undefined;
    requireStorage?: boolean | undefined;
    requireSearch?: boolean | undefined;
    batchSize?: number | undefined;
    volumeSearch?: boolean | undefined;
    volumeMailMessages?: number | undefined;
    anchorDate?: string | undefined;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--skip-migrate":
        options.migrate = false;
        break;
      case "--skip-reindex":
        options.reindex = false;
        break;
      case "--skip-verify":
        options.verify = false;
        break;
      case "--require-storage":
        options.requireStorage = true;
        break;
      case "--require-search":
        options.requireSearch = true;
        break;
      case "--volume-search":
        options.volumeSearch = true;
        break;
      case "--volume-mail-count": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--volume-mail-count requires a positive integer");
        }
        options.volumeMailMessages = parsePositiveInteger(value, "--volume-mail-count");
        options.volumeSearch = true;
        index += 1;
        break;
      }
      case "--anchor-date": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--anchor-date requires YYYY-MM-DD");
        }
        options.anchorDate = parseAnchorDateArg(value);
        index += 1;
        break;
      }
      case "--batch-size": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--batch-size requires a positive integer");
        }
        options.batchSize = parsePositiveInteger(value, "--batch-size");
        index += 1;
        break;
      }
      case "-h":
      case "--help":
        throw new Error(usage);
      default:
        throw new Error(`Unknown option: ${arg ?? ""}\n${usage}`);
    }
  }

  return {
    migrate: options.migrate ?? defaultOptions.migrate,
    reindex: options.reindex ?? defaultOptions.reindex,
    verify: options.verify ?? defaultOptions.verify,
    requireStorage: options.requireStorage ?? defaultOptions.requireStorage,
    requireSearch: options.requireSearch ?? defaultOptions.requireSearch,
    volumeSearch: options.volumeSearch ?? defaultOptions.volumeSearch,
    volumeMailMessages: options.volumeMailMessages ?? defaultOptions.volumeMailMessages,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.anchorDate === undefined ? {} : { anchorDate: options.anchorDate }),
  };
}

export async function prepareLocalDemo(
  sql: postgres.Sql,
  options: PrepareLocalDemoOptions = defaultOptions,
): Promise<PrepareLocalDemoResult> {
  const migrations = options.migrate ? await migratePlatform(sql) : null;
  const seed = await seedLocalDemo(sql, {
    ...(options.anchorDate === undefined ? {} : { anchorDate: options.anchorDate }),
    volumeSearch: options.volumeSearch ? { mailMessages: options.volumeMailMessages } : undefined,
  });
  if (options.requireStorage && seed.storageObjects < 5) {
    throw new Error(
      "Local demo preparation requires storage, but no RustFS/S3 configuration was found",
    );
  }
  const reindex = options.reindex
    ? await reindexSearch(sql, {
        requireAll: true,
        orgId: DEFAULT_LOCAL_OAUTH_ORG_ID,
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      })
    : null;
  if (options.requireSearch && (reindex === null || !reindex.searchConfigured)) {
    throw new Error(
      "Local demo preparation requires search, but no Meilisearch configuration was found",
    );
  }

  const verification = options.verify
    ? await verifyLocalDemo(sql, {
        ...(options.anchorDate === undefined ? {} : { anchorDate: options.anchorDate }),
      })
    : null;
  if (verification !== null) {
    if (options.requireStorage && !verification.storageConfigured) {
      throw new Error(
        "Local demo preparation requires storage, but no RustFS/S3 configuration was found",
      );
    }
    if (options.requireSearch && !verification.searchConfigured) {
      throw new Error(
        "Local demo preparation requires search, but no Meilisearch configuration was found",
      );
    }
  }

  return {
    ok: true,
    migrations,
    seed,
    reindex,
    verification,
  };
}

async function migratePlatform(sql: postgres.Sql): Promise<MigrationRunResult> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return runMigrations(sql, [
    {
      namespace: "platform",
      directory: join(currentDir, "migrations"),
    },
  ]);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseAnchorDateArg(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--anchor-date requires YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("--anchor-date requires a valid calendar date");
  }
  return value;
}

const usage = `Usage: pnpm --filter @helix/app db:prepare:demo -- [--skip-migrate] [--skip-reindex] [--skip-verify] [--require-storage] [--require-search] [--batch-size <n>] [--volume-search] [--volume-mail-count <n>] [--anchor-date <YYYY-MM-DD>]`;

async function main(): Promise<void> {
  let options: PrepareLocalDemoOptions;
  try {
    options = parsePrepareLocalDemoArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const sql = createSqlClient();
  try {
    const result = await prepareLocalDemo(sql, options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
