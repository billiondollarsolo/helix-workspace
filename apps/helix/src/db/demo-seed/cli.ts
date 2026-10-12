import { pathToFileURL } from "node:url";
import { env, loadMigrationEnv } from "../../config/env.js";
import { createMigrationSqlClient, createSqlClient, resolveDatabaseUrl } from "../client.js";
import { seedDemo, type DemoSeedOptions } from "./index.js";
import { parseDemoSize } from "./presets.js";
import { DemoSeedError } from "./runtime.js";

const USAGE = `Usage: pnpm --filter @helix/app db:seed:demo -- [--size small|medium|large] [--reset] [--accounts-only]

  --size           Volume preset (default medium; CI uses small).
  --reset          Drop the demo tenant (rows, stored objects, search documents) first.
  --accounts-only  Only the tenant, people, sign-ins, domains, groups and account states.

History ends at the current minute, so scheduled mail, snoozes and today's
meetings are always ahead; the content itself is the same on every run.`;

export function parseDemoSeedArgs(args: readonly string[], now = new Date()): DemoSeedOptions {
  let size = parseDemoSize("medium");
  let reset = false;
  let accountsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    else if (arg === "--size") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--size needs a value.\n${USAGE}`);
      }
      size = parseDemoSize(next);
      index += 1;
    } else if (arg === "--reset") reset = true;
    else if (arg === "--accounts-only") accountsOnly = true;
    else throw new Error(`Unknown option ${arg ?? ""}.\n${USAGE}`);
  }
  // Whole minutes keep generated times tidy.
  const minute = new Date(now);
  minute.setUTCSeconds(0, 0);
  return { size, reset, accountsOnly, now: minute };
}

/** The seed writes fictional data and can drop a tenant: local development only. */
export function assertLocalSeedTarget(urls: readonly (string | undefined)[]): void {
  if (env().NODE_ENV === "production") {
    throw new Error("The demo seed is for local development and CI only; NODE_ENV is production.");
  }
  for (const url of urls) {
    if (url === undefined) continue;
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      throw new Error(`The demo seed only writes to loopback services; refusing ${host}.`);
    }
  }
}

async function main(): Promise<void> {
  let options: DemoSeedOptions;
  try {
    options = parseDemoSeedArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const migrationEnv = loadMigrationEnv();
  assertLocalSeedTarget([resolveDatabaseUrl(), env().RUSTFS_ENDPOINT, env().MEILI_HOST]);
  const sql = createSqlClient();
  const privilegedSql = createMigrationSqlClient(migrationEnv);
  try {
    const summary = await seedDemo({
      sql,
      privilegedSql,
      options,
      log: (message) => {
        console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
      },
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`Demo seed failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!(error instanceof DemoSeedError) && error instanceof Error) console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await sql.end();
    await privilegedSql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
