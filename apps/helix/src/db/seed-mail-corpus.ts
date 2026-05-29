/* Seed the 300-EML test corpus into the admin user's Mail inbox.
 *
 * The test-corpus generator writes .eml files into test-corpus/generated/email/
 * but those land in Drive (object storage) — not the Mail inbox. This seeder
 * walks those EMLs, parses each via mailparser, and inserts:
 *   - one `threads` row per email (kind=mail)
 *   - one `messages` row attributed to admin (kind=mail)
 *   - one `mail_thread_state` row pinning the thread to the inbox label
 *   - a `permissions` row granting admin the thread owner role
 *
 * Idempotent on (orgId, messageId) — re-running won't duplicate rows.
 * Wired into `dev-up.sh --seed` so admin@helix.local always logs in to a
 * realistic mailbox.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { simpleParser, type ParsedMail } from "mailparser";
import { createSqlClient } from "./client.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const CORPUS_DIR = path.join(REPO_ROOT, "test-corpus/generated/email");

const ADMIN_ACTOR_ID = "00000000-0000-4000-8000-000000000110";
const ADMIN_EMAIL = "admin@helix.local";

const MAIL_CORPUS_SOURCE = "mail-corpus";

export interface SeedMailCorpusResult {
  readonly orgId: string;
  readonly actorId: string;
  readonly scanned: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly errors: number;
}

export async function seedMailCorpus(
  sql: ReturnType<typeof createSqlClient>,
  options: { readonly orgId?: string; readonly actorId?: string; readonly limit?: number } = {},
): Promise<SeedMailCorpusResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const actorId = options.actorId ?? ADMIN_ACTOR_ID;

  let entries: string[];
  try {
    entries = (await readdir(CORPUS_DIR)).filter((n) => n.toLowerCase().endsWith(".eml")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Corpus dir not found at ${CORPUS_DIR}. Run \`pnpm corpus:fetch --only=synthetic-email\` first.`,
      );
    }
    throw err;
  }

  const limited = options.limit !== undefined ? entries.slice(0, options.limit) : entries;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const filename of limited) {
    const filePath = path.join(CORPUS_DIR, filename);
    try {
      const bytes = await readFile(filePath);
      const parsed = await simpleParser(bytes);
      const result = await insertEmail(sql, orgId, actorId, parsed, filename);
      if (result === "inserted") inserted += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      console.warn(`  ⚠ ${filename}: ${(err as Error).message}`);
    }
  }

  return { orgId, actorId, scanned: limited.length, inserted, skipped, errors };
}

async function insertEmail(
  sql: ReturnType<typeof createSqlClient>,
  orgId: string,
  actorId: string,
  mail: ParsedMail,
  filename: string,
): Promise<"inserted" | "skipped"> {
  const messageId = (mail.messageId ?? `<corpus-${filename}@helix.local>`).replace(/[<>]/g, "");
  const subject = mail.subject ?? "(no subject)";
  // mailparser gives `from`/`to` as either single address object or array; normalize.
  // Spread into plain JSON-friendly shapes before handing to sql.json.
  const fromRaw = mail.from?.value?.[0];
  const fromAddress = {
    address: fromRaw?.address ?? "unknown@example",
    name: fromRaw?.name ?? "",
  };
  const toList = (mail.to ? (Array.isArray(mail.to) ? mail.to : [mail.to]) : []).flatMap((g) =>
    g.value.map((v) => ({ address: v.address ?? "", name: v.name ?? "" })),
  );
  const ccList = (mail.cc ? (Array.isArray(mail.cc) ? mail.cc : [mail.cc]) : []).flatMap((g) =>
    g.value.map((v) => ({ address: v.address ?? "", name: v.name ?? "" })),
  );
  const sentAt = mail.date ?? new Date();
  const bodyPlain = (mail.text ?? "").trim();
  const bodyHtml = mail.html === false ? null : (mail.html as string | undefined) ?? null;
  const body = bodyPlain.length > 0 ? bodyPlain : (bodyHtml ?? "").replace(/<[^>]+>/g, " ").trim();
  const bodyFormat = bodyHtml !== null && bodyPlain.length === 0 ? "html" : "plain";

  // Dedup by (orgId, messageId).
  const existing = await sql<
    { id: string }[]
  >`select id from threads where org_id = ${orgId} and metadata->>'messageId' = ${messageId} limit 1`;
  if (existing.length > 0) return "skipped";

  const threadRow = await sql<
    { id: string }[]
  >`
    insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
    values (
      ${orgId},
      'mail',
      ${subject},
      ${actorId},
      ${sql.json({
        source: MAIL_CORPUS_SOURCE,
        messageId,
        sourceFilename: filename,
      })}
    )
    returning id
  `;
  const threadId = threadRow[0]!.id;

  const messageRow = await sql<{ id: string }[]>`
    insert into messages (org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
    values (
      ${orgId},
      ${threadId},
      ${actorId},
      'mail',
      ${body},
      ${bodyFormat},
      ${sql.json({
        source: MAIL_CORPUS_SOURCE,
        direction: "inbound",
        from: fromAddress,
        to: toList.length > 0 ? toList : [{ address: ADMIN_EMAIL, name: "Admin" }],
        cc: ccList,
        bcc: [],
        subject,
        messageId,
        inReplyTo: mail.inReplyTo ?? null,
        references: Array.isArray(mail.references)
          ? mail.references
          : mail.references !== undefined
            ? [mail.references]
            : [],
        bodyHtml,
      })},
      ${sentAt}
    )
    returning id
  `;
  const messageId_row = messageRow[0]!.id;

  // Attachments: mailparser exposes each part on `mail.attachments`. Insert
  // an `objects` row + a `message_attachments` link row for each so the
  // mail list paperclip indicator (driven by EXISTS on message_attachments)
  // lights up. Storage is filename-keyed; the bytes live as inlineBody on
  // the object metadata (the existing dev fallback in server.ts:2611 reads
  // these when storage is unavailable, so downloads still work).
  const attachments = mail.attachments ?? [];
  for (const att of attachments) {
    if (!Buffer.isBuffer(att.content) || att.content.byteLength === 0) continue;
    const filename = att.filename ?? `attachment-${attachments.indexOf(att)}.bin`;
    const mimeType = att.contentType ?? "application/octet-stream";
    const sha256 = createHash("sha256").update(att.content).digest("hex");
    const storageKey = `mail/${messageId_row}/${filename}`;
    const inlineBody = att.content.toString("base64");

    const objectRow = await sql<{ id: string }[]>`
      insert into objects (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${orgId},
        ${actorId},
        'mail_attachment',
        ${storageKey},
        ${mimeType},
        ${att.content.byteLength},
        ${sha256},
        ${sql.json({
          source: MAIL_CORPUS_SOURCE,
          filename,
          contentId: att.cid ?? null,
          inlineBody,
          inlineMime: mimeType,
        })}
      )
      returning id
    `;
    const objectId = objectRow[0]!.id;

    await sql`
      insert into message_attachments (message_id, object_id, disposition)
      values (${messageId_row}, ${objectId}, ${att.contentDisposition ?? "attachment"})
    `;
    await sql`
      insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${orgId}, ${actorId}, 'object', ${objectId}, 'owner', ${actorId})
    `;
  }

  await sql`
    insert into mail_thread_state (actor_id, thread_id, org_id, labels, archived_at, deleted_at, snoozed_until, read_at, starred, updated_at)
    values (
      ${actorId},
      ${threadId},
      ${orgId},
      ${sql.array(["inbox"])},
      null,
      null,
      null,
      null,
      false,
      now()
    )
  `;

  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, 'thread', ${threadId}, 'owner', ${actorId})
  `;

  return "inserted";
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await seedMailCorpus(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
