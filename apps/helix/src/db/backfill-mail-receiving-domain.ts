import process from "node:process";
import { pathToFileURL } from "node:url";
import { env } from "../config/env.js";
import { createSqlClient } from "./client.js";
import { backfillSingleTenantReceivingDomain } from "../platform/mail/receiving-domain-backfill.js";
import { PostgresReceivingDomainStore } from "../platform/mail/receiving-domains-store.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Flags that consume the following argument as their value. */
const VALUE_FLAGS = ["--org-id", "--domain", "--created-by", "--catch-all-actor-id"];

export interface ReceivingDomainBackfillCommand {
  readonly orgId: string;
  readonly domain: string;
  readonly createdBy: string;
  readonly catchAllActorId?: string;
}

export function parseReceivingDomainBackfillArgs(
  args: readonly string[],
): ReceivingDomainBackfillCommand {
  const values = new Map<string, string>();
  let ownershipAttested = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--ownership-attested") {
      ownershipAttested = true;
      continue;
    }
    if (argument === undefined || !VALUE_FLAGS.includes(argument)) {
      throw new Error(`Unknown receiving-domain backfill argument: ${argument ?? ""}`);
    }
    const value = args[index + 1]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const orgId = values.get("--org-id");
  const domain = values.get("--domain");
  const createdBy = values.get("--created-by");
  const catchAllActorId = values.get("--catch-all-actor-id");
  if (orgId === undefined || domain === undefined || createdBy === undefined) {
    throw new Error("--org-id, --domain, and --created-by are required.");
  }
  if (!ownershipAttested) {
    throw new Error("--ownership-attested is required after verifying control of the domain.");
  }
  for (const [name, value] of [
    ["--org-id", orgId],
    ["--created-by", createdBy],
    ["--catch-all-actor-id", catchAllActorId],
  ] as const) {
    if (value !== undefined && !uuid.test(value)) {
      throw new Error(`${name} must be a UUID.`);
    }
  }
  return {
    orgId,
    domain,
    createdBy,
    ...(catchAllActorId === undefined ? {} : { catchAllActorId }),
  };
}

async function main(): Promise<void> {
  const command = parseReceivingDomainBackfillArgs(process.argv.slice(2));
  const runtime = env();
  if (runtime.HELIX_MODE !== "single-tenant") {
    throw new Error("Receiving-domain backfill is only available in explicit single-tenant mode.");
  }
  const sql = createSqlClient();
  try {
    const record = await backfillSingleTenantReceivingDomain(
      new PostgresReceivingDomainStore(sql),
      {
        deploymentMode: runtime.HELIX_MODE,
        orgId: command.orgId,
        domain: command.domain,
        createdBy: command.createdBy,
        catchAllActorId: command.catchAllActorId ?? null,
        ownershipAttested: true,
      },
    );
    process.stdout.write(
      `${JSON.stringify({
        id: record.id,
        orgId: record.orgId,
        domain: record.domain,
        status: record.status,
        idempotent: true,
      })}\n`,
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
