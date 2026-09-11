import type { StorageClient } from "@helix/sdk-types";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { toUint8Array } from "../platform/drive/store/storage.js";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";
import { createSqlClient } from "./client.js";
import { insertMailMessage } from "../platform/mail/store-message-write.js";
import {
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_DOMAINS,
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
  const { counts, files, liveSend } = await withTenantPostgresContext(
    sql,
    { orgId },
    async (tx) => {
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
      const notes = files.find((file) => file.seed_key === "0-notes");
      if (!notes) throw new Error("Samara's private notes file is missing.");
      const outsiderNotes = await tx<
        { role: string | null }[]
      >`select helix_drive_effective_role(${orgId}, ${teamPerson(1).actorId}, 'object', ${notes.id}) as role`;
      if (outsiderNotes[0]?.role !== null)
        throw new Error("Personal working notes leaked to a teammate who was not granted access.");
      const domains = await tx<
        { domain: string }[]
      >`select domain from admin_domains where org_id = ${orgId} and domain = any(${tx.array([...LOCAL_TEAM_DOMAINS], 1009)}) and status = 'verified'`;
      if (domains.length !== LOCAL_TEAM_DOMAINS.length)
        throw new Error("Harbor and Helix local mail domains are not both verified.");
      const alias = teamPerson(0).aliases[0];
      if (alias === undefined) throw new Error("Samara is missing a harbor.local alias.");
      const aliasMailbox = await tx<
        { actor_id: string }[]
      >`select actor_id from helix_resolve_inbound_mailboxes(${alias}, 'harbor.local', 100)`;
      if (aliasMailbox[0]?.actor_id !== teamPerson(0).actorId)
        throw new Error(`Inbound alias ${alias} did not resolve to Samara.`);
      const liveSend = await exerciseInternalMail(tx, orgId);
      return { counts, files, liveSend };
    },
  );
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
    liveSend,
  };
}

async function exerciseInternalMail(tx: postgres.TransactionSql, orgId: string) {
  const sender = teamPerson(0);
  const recipient = teamPerson(1);
  const from = sender.aliases[0] ?? sender.email;
  const to = recipient.aliases[0] ?? recipient.email;
  const existing = await tx<
    { id: string; thread_id: string }[]
  >`select id, thread_id from messages where org_id = ${orgId} and metadata->>'seedKey' = 'live-internal-send' limit 1`;
  const delivered =
    existing[0] === undefined
      ? await insertMailMessage(tx, {
          orgId,
          actorId: sender.actorId,
          mailboxActorIds: [sender.actorId, recipient.actorId],
          from: { address: from, name: sender.displayName },
          to: [{ address: to, name: recipient.displayName }],
          subject: "Live Harbor internal send",
          bodyText: `Hi ${recipient.firstName},\n\nThis was delivered on-server from ${from} to ${to}.\n\n${sender.displayName}`,
          metadata: {
            source: LOCAL_TEAM_SOURCE,
            seedKey: "live-internal-send",
            direction: "outbound",
          },
        })
      : { messageId: existing[0].id, threadId: existing[0].thread_id };
  for (const actorId of [sender.actorId, recipient.actorId]) {
    await tx`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${orgId}, ${actorId}, 'thread', ${delivered.threadId}, 'owner', ${sender.actorId})
      on conflict do nothing`;
  }
  const inbox = await tx<
    { actor_id: string }[]
  >`select actor_id from mail_thread_state where org_id = ${orgId} and thread_id = ${delivered.threadId}`;
  const actorIds = inbox.map((row) => row.actor_id).sort();
  if (!actorIds.includes(recipient.actorId) || !actorIds.includes(sender.actorId))
    throw new Error("Internal Harbor mail did not land in both mailboxes.");
  return {
    from,
    to,
    messageId: delivered.messageId,
    threadId: delivered.threadId,
    mailboxActorIds: actorIds,
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
