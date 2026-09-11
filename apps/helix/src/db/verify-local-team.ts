import type { StorageClient } from "@helix/sdk-types";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { toUint8Array } from "../platform/drive/store/storage.js";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";
import { createSqlClient } from "./client.js";
import {
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_SOURCE,
  teamFileFixtures,
  teamPerson,
} from "./local-team-fixtures.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";
import { assertLocalTeamTarget, localTeamResolvedStorage } from "./seed-local-team.js";

/** Read-only fixture verification, safe to run against the active local workspace. */
export async function verifyLocalTeam(
  sql: postgres.Sql,
  storage: StorageClient,
  orgId = DEFAULT_LOCAL_OAUTH_ORG_ID,
) {
  const { counts, files } = await withTenantPostgresContext(sql, { orgId }, async (tx) => {
    const rows = await tx<Record<string, number>[]>`select
      (select count(*)::int from actors where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as accounts,
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'mail' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as mail_threads,
      (select count(*)::int from messages where org_id = ${orgId} and kind = 'mail' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as mail_messages,
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'chat_room' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as chat_rooms,
      (select count(*)::int from chat_room_settings where org_id = ${orgId} and participant_key = any(${tx.array(
        LOCAL_TEAM_DIRECT_MESSAGES.map((direct) => direct.participantKey),
        1009,
      )})) as direct_messages,
      (select count(*)::int from messages where org_id = ${orgId} and kind = 'chat' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as chat_messages,
      (select count(*)::int from assistant_conversations where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as assistant_conversations,
      (select count(*)::int from assistant_messages where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as assistant_messages,
      (select count(*)::int from cal_events where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as calendar_events,
      (select count(*)::int from drive_folders where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as drive_folders`;
    const expected = {
      accounts: 10,
      mail_threads: 20,
      mail_messages: 60,
      chat_rooms: 5,
      direct_messages: 10,
      chat_messages: 80,
      assistant_conversations: 30,
      assistant_messages: 120,
      calendar_events: 30,
      drive_folders: 13,
    };
    const counts = rows[0];
    assert(counts, "Team count query returned no row.");
    for (const [name, count] of Object.entries(expected)) {
      if (counts[name] !== count)
        throw new Error(
          `Team fixture ${name}: expected ${String(count)}, found ${String(counts[name] ?? 0)}.`,
        );
    }
    const files = await tx<
      {
        id: string;
        storage_key: string;
        sha256: string;
        byte_size: string;
        owner_actor_id: string;
        status: string;
        scanned_at: string | null;
        seed_key: string;
      }[]
    >`
      select id, storage_key, sha256, byte_size, owner_actor_id, metadata->>'status' as status,
        metadata->>'avScannedAt' as scanned_at, metadata->>'seedKey' as seed_key
      from objects where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE} order by metadata->>'seedKey'`;
    if (files.length !== teamFileFixtures().length)
      throw new Error(`Expected 34 Drive files, found ${String(files.length)}.`);
    const privateFile = files.find((file) => file.seed_key === "private-decision");
    if (!privateFile) throw new Error("Private launch file is missing.");
    for (const [index, expectedRole] of [
      [0, "owner"],
      [1, "editor"],
      [9, null],
    ] as const) {
      const roles = await tx<
        { role: string | null }[]
      >`select helix_drive_effective_role(${orgId}, ${teamPerson(index).actorId}, 'object', ${privateFile.id}) as role`;
      if (roles[0]?.role !== expectedRole)
        throw new Error(
          `Private launch file access is incorrect for ${teamPerson(index).displayName}.`,
        );
    }
    return { counts, files };
  });
  let verifiedBytes = 0;
  for (const file of files) {
    if (file.status !== "ready" || !file.scanned_at)
      throw new Error(`Drive fixture is not scan-clean: ${file.seed_key}.`);
    const stored = await storage.get(file.storage_key);
    if (!stored) throw new Error(`Drive fixture bytes are missing: ${file.seed_key}.`);
    const bytes = await toUint8Array(stored.body);
    if (
      bytes.byteLength !== Number(file.byte_size) ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new Error(
        `Drive fixture byte count or SHA256 differs from the current version: ${file.seed_key}.`,
      );
    }
    verifiedBytes += bytes.byteLength;
  }
  return {
    ok: true,
    orgId,
    source: LOCAL_TEAM_SOURCE,
    counts: { ...counts, drive_files: files.length },
    verifiedBytes,
    privateDriveBoundary: "owner/editor/outsider verified",
  };
}

async function main() {
  assertLocalTeamTarget();
  const sql = createSqlClient();
  try {
    console.log(
      JSON.stringify(await verifyLocalTeam(sql, await localTeamResolvedStorage(sql)), null, 2),
    );
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
