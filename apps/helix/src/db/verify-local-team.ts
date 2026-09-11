import type { StorageClient } from "@helix/sdk-types";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { toUint8Array } from "../platform/drive/store/storage.js";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";
import { createSqlClient } from "./client.js";
import { insertMailMessage } from "../platform/mail/store-message-write.js";
import { teamFileFixtures, teamFolderFixtures } from "./local-team-drive-fixtures.js";
import {
  LOCAL_TEAM_ADMIN,
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_DOMAINS,
  LOCAL_TEAM_SOURCE,
  teamId,
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
      (select count(*)::int from messages where org_id = ${orgId} and kind = 'mail' and metadata->>'source' = ${LOCAL_TEAM_SOURCE} and coalesce(metadata->>'seedKey','') <> 'live-internal-send') as mail_messages,
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'chat_room' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as chat_rooms,
      (select count(distinct thread_id)::int from chat_room_settings where org_id = ${orgId} and (
        participant_key = any(${tx.array(
          LOCAL_TEAM_DIRECT_MESSAGES.map((direct) => direct.participantKey),
          1009,
        )})
        or thread_id = ${teamId(3, 201)}
      )) as direct_messages,
      (select count(*)::int from messages where org_id = ${orgId} and kind = 'chat' and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as chat_messages,
      (select count(*)::int from assistant_conversations where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as assistant_conversations,
      (select count(*)::int from assistant_messages where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as assistant_messages,
      (select count(*)::int from cal_events where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as calendar_events,
      (select count(*)::int from drive_folders where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}) as drive_folders`;
      const adminPresent = await tx<
        { id: string }[]
      >`select id from actors where org_id = ${orgId} and id = ${LOCAL_TEAM_ADMIN.actorId}`;
      const withAdmin = adminPresent.length > 0;
      const expected = {
        accounts: 10,
        mail_threads: withAdmin ? 21 : 20,
        mail_messages: withAdmin ? 62 : 60,
        chat_rooms: 5,
        direct_messages: withAdmin ? 11 : 10,
        chat_messages: withAdmin ? 83 : 80,
        assistant_conversations: withAdmin ? 31 : 30,
        assistant_messages: withAdmin ? 122 : 120,
        calendar_events: 30,
        drive_folders: teamFolderFixtures().length,
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
        throw new Error(
          `Expected ${String(teamFileFixtures().length)} Drive files, found ${String(files.length)}.`,
        );
      const pairFile = files.find((file) => file.seed_key === "pair-customer-brief");
      if (!pairFile) throw new Error("Customer briefing pair-share file is missing.");
      await assertDriveRoles(tx, orgId, pairFile.id, [
        [0, "owner"],
        [4, "editor"],
        [8, null],
      ]);
      const privateFile = files.find((file) => file.seed_key === "private-decision");
      if (!privateFile) throw new Error("Private launch file is missing.");
      await assertDriveRoles(tx, orgId, privateFile.id, [
        [0, "owner"],
        [1, "editor"],
        [9, null],
      ]);
      const brief = files.find((file) => file.seed_key === "0-brief");
      if (!brief) throw new Error("Samara's shared brief is missing.");
      await assertDriveRoles(tx, orgId, brief.id, [
        [0, "owner"],
        [4, "editor"],
        [1, null],
        [8, null],
      ]);
      const nestedWeek = files.find((file) => file.seed_key === "weekly-week-1");
      if (!nestedWeek) throw new Error("Nested week-1 notes are missing.");
      await assertDriveRoles(tx, orgId, nestedWeek.id, [
        [0, "owner"],
        [9, "editor"],
        [7, "editor"],
      ]);
      const runbook = files.find((file) => file.seed_key === "engineering-runbook");
      if (!runbook) throw new Error("Engineering runbook is missing.");
      await assertDriveRoles(tx, orgId, runbook.id, [
        [1, "owner"],
        [3, "editor"],
        [7, "reader"],
        [6, null],
      ]);
      const notes = files.find((file) => file.seed_key === "0-notes");
      if (!notes) throw new Error("Samara's private notes file is missing.");
      const outsiderNotes = await tx<
        { role: string | null }[]
      >`select helix_drive_effective_role(${orgId}, ${teamPerson(1).actorId}, 'object', ${notes.id}) as role`;
      if (outsiderNotes[0]?.role !== null)
        throw new Error("Personal working notes leaked to a teammate who was not granted access.");
      if (withAdmin) {
        const adminLaunch = await tx<
          { role: string | null }[]
        >`select helix_drive_effective_role(${orgId}, ${LOCAL_TEAM_ADMIN.actorId}, 'object', ${privateFile.id}) as role`;
        if (adminLaunch[0]?.role !== "editor")
          throw new Error("Workspace admin is missing shared launch-file access.");
        const adminNotes = await tx<
          { role: string | null }[]
        >`select helix_drive_effective_role(${orgId}, ${LOCAL_TEAM_ADMIN.actorId}, 'object', ${notes.id}) as role`;
        if (adminNotes[0]?.role !== null)
          throw new Error("Workspace admin can open personal working notes that were not shared.");
        const adminBrief = await tx<
          { role: string | null }[]
        >`select helix_drive_effective_role(${orgId}, ${LOCAL_TEAM_ADMIN.actorId}, 'object', ${brief.id}) as role`;
        if (adminBrief[0]?.role !== "reader")
          throw new Error("Workspace admin should have reader access to Samara's shared brief.");
        const adminPair = await tx<
          { role: string | null }[]
        >`select helix_drive_effective_role(${orgId}, ${LOCAL_TEAM_ADMIN.actorId}, 'object', ${pairFile.id}) as role`;
        if (adminPair[0]?.role !== null)
          throw new Error("Workspace admin can open a pair-share folder that was not granted.");
        const adminAlias = LOCAL_TEAM_ADMIN.aliases[0];
        const mailbox = await tx<
          { actor_id: string }[]
        >`select actor_id from helix_resolve_inbound_mailboxes(${adminAlias}, 'harbor.local', 100)`;
        if (mailbox[0]?.actor_id !== LOCAL_TEAM_ADMIN.actorId)
          throw new Error(`Admin alias ${adminAlias} did not resolve.`);
      }
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

async function assertDriveRoles(
  tx: postgres.TransactionSql,
  orgId: string,
  objectId: string,
  expected: readonly (readonly [number, string | null])[],
) {
  for (const [index, role] of expected) {
    const rows = await tx<
      { role: string | null }[]
    >`select helix_drive_effective_role(${orgId}, ${teamPerson(index).actorId}, 'object', ${objectId}) as role`;
    if (rows[0]?.role !== role)
      throw new Error(`Drive access is incorrect for ${teamPerson(index).displayName}.`);
  }
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
