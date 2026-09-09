import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { AntivirusScanner } from "./antivirus.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type { MailAttachmentInput } from "./types.js";

const STAGE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_RETRY_MS = 5 * 60 * 1000;

export interface StagedMailAttachment {
  readonly stageId: string;
  readonly objectId: string;
  readonly orgId: string;
  readonly ownerActorId?: string | undefined;
  readonly storageKey: string;
  readonly attachment: MailAttachmentInput;
}

export class MailAttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAttachmentRejectedError";
  }
}

export class PostgresMailAttachmentIngestor {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: {
      readonly storageResolver: TenantStorageResolver;
      readonly scanner?: AntivirusScanner | undefined;
      readonly scannerFailurePolicy?: "reject" | "retain-quarantine" | undefined;
      readonly now?: (() => Date) | undefined;
    },
  ) {}

  async stage(input: {
    readonly orgId: string;
    readonly ownerActorId?: string | undefined;
    readonly attachment: MailAttachmentInput & { readonly content: Buffer };
  }): Promise<StagedMailAttachment> {
    const now = this.options.now?.() ?? new Date();
    const stageId = randomUUID();
    const objectId = randomUUID();
    const bytes = Buffer.from(input.attachment.content);
    const expectedSha256 = sha256(bytes);
    const storageKey = `mail/attachments/${stageId}/${expectedSha256}`;
    const storage = await this.options.storageResolver({ orgId: input.orgId });
    if (storage === undefined)
      throw new MailAttachmentRejectedError("Mail attachment storage is unavailable.");

    await this.phase(input.orgId, input.ownerActorId, async (tx) => {
      await tx`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
        ) values (
          ${objectId}, ${input.orgId}, ${input.ownerActorId ?? null}, 'mail_attachment',
          ${storageKey}, ${input.attachment.mimeType}, ${bytes.byteLength}, ${expectedSha256},
          ${tx.json({ ingestState: "pending_upload", stageId })}
        )
      `;
      await tx`
        insert into mail_attachment_ingestions (
          id, org_id, owner_actor_id, object_id, status, storage_key, filename, disposition,
          declared_mime_type, expected_byte_size, expected_sha256, expires_at
        ) values (
          ${stageId}, ${input.orgId}, ${input.ownerActorId ?? null}, ${objectId}, 'pending_upload',
          ${storageKey}, ${input.attachment.filename ?? null},
          ${input.attachment.disposition ?? "attachment"}, ${input.attachment.mimeType},
          ${bytes.byteLength}, ${expectedSha256}, ${new Date(now.getTime() + STAGE_TTL_MS)}
        )
      `;
    });

    try {
      await storage.client.put({
        key: storageKey,
        body: bytes,
        contentType: input.attachment.mimeType,
        metadata: { stageId, objectId, sha256: expectedSha256 },
      });
      const authoritative = await readAuthoritativeObject(
        storage.client,
        storageKey,
        bytes.byteLength,
      );
      if (authoritative.byteSize !== bytes.byteLength || authoritative.sha256 !== expectedSha256) {
        throw new MailAttachmentRejectedError(
          "Stored mail attachment metadata does not match its upload.",
        );
      }
      await this.phase(input.orgId, input.ownerActorId, async (tx) => {
        await tx`
          update mail_attachment_ingestions set status = 'quarantined',
            authoritative_mime_type = ${authoritative.mimeType},
            actual_byte_size = ${authoritative.byteSize}, actual_sha256 = ${authoritative.sha256},
            updated_at = now()
          where org_id = ${input.orgId} and id = ${stageId} and status = 'pending_upload'
        `;
        await tx`
          update objects set mime_type = ${authoritative.mimeType}, byte_size = ${authoritative.byteSize},
            sha256 = ${authoritative.sha256},
            metadata = metadata || ${tx.json({ ingestState: "quarantined", stageId })}, updated_at = now()
          where org_id = ${input.orgId} and id = ${objectId}
        `;
      });
      await this.phase(input.orgId, input.ownerActorId, async (tx) => {
        await tx`
          update mail_attachment_ingestions set status = 'scanning', updated_at = now()
          where org_id = ${input.orgId} and id = ${stageId} and status = 'quarantined'
        `;
      });
      if (this.options.scanner === undefined) {
        throw new MailAttachmentRejectedError("Mail attachment antivirus scanning is unavailable.");
      }
      const scan = await this.options.scanner.scan(authoritative.bytes);
      if (!scan.scanned) {
        throw new MailAttachmentRejectedError(
          "Mail attachment antivirus scanning was not completed.",
        );
      }
      if (scan.infected) {
        throw new MailAttachmentRejectedError(
          `Mail attachment failed antivirus scanning: ${scan.signature ?? "unknown"}.`,
        );
      }
      const updated = await this.phase(
        input.orgId,
        input.ownerActorId,
        async (tx) =>
          tx<{ readonly id: string }[]>`
          update mail_attachment_ingestions set status = 'clean',
            scan_evidence = ${tx.json({ ...scan.evidence, scanned: true, infected: false })},
            updated_at = now()
          where org_id = ${input.orgId} and id = ${stageId} and status = 'scanning'
          returning id
        `,
      );
      if (updated[0] === undefined)
        throw new Error("Mail attachment stage was concurrently changed.");
      return {
        stageId,
        objectId,
        orgId: input.orgId,
        ...(input.ownerActorId === undefined ? {} : { ownerActorId: input.ownerActorId }),
        storageKey,
        attachment: withoutContent(input.attachment, objectId),
      };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : "Attachment ingestion failed.";
      await this.reject(input.orgId, input.ownerActorId, stageId, objectId, reason);
      if (this.options.scannerFailurePolicy !== "retain-quarantine") {
        await this.deleteAndMarkCleaned(
          input.orgId,
          input.ownerActorId,
          stageId,
          objectId,
          storageKey,
        );
      }
      throw error instanceof MailAttachmentRejectedError
        ? error
        : new MailAttachmentRejectedError(reason);
    }
  }

  async release(stages: readonly StagedMailAttachment[]): Promise<void> {
    for (const stage of stages) {
      await this.reject(
        stage.orgId,
        stage.ownerActorId,
        stage.stageId,
        stage.objectId,
        "Attachment was not attached.",
      );
      const storage = await this.options.storageResolver({ orgId: stage.orgId });
      if (storage !== undefined) {
        await this.deleteAndMarkCleaned(
          stage.orgId,
          stage.ownerActorId,
          stage.stageId,
          stage.objectId,
          stage.storageKey,
        );
      }
    }
  }

  async cleanupAbandoned(limit = 100): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    await this.sql`select helix_expire_mail_drafts(${Math.min(Math.max(limit, 1), 500)}, ${now})`;
    const rows = await this.sql<
      {
        readonly id: string;
        readonly org_id: string;
        readonly owner_actor_id: string | null;
        readonly object_id: string;
        readonly storage_key: string;
      }[]
    >`
        select * from helix_claim_mail_attachment_cleanup(
          ${Math.min(Math.max(limit, 1), 500)},
          ${now},
          ${new Date(now.getTime() + CLEANUP_RETRY_MS)}
        )
      `;
    let cleaned = 0;
    for (const row of rows) {
      try {
        const storage = await this.options.storageResolver({ orgId: row.org_id });
        if (storage === undefined) throw new Error("Mail attachment storage is unavailable.");
        await storage.client.delete(row.storage_key);
        await this.phase(row.org_id, row.owner_actor_id ?? undefined, async (tx) => {
          await tx`
            update mail_attachment_ingestions set status = 'rejected',
              failure_reason = coalesce(failure_reason, 'Attachment stage expired.'),
              rejected_at = coalesce(rejected_at, now()), cleaned_at = now(),
              last_cleanup_error = null, updated_at = now()
            where org_id = ${row.org_id} and id = ${row.id} and status <> 'attached'
          `;
          await tx`
            update objects set deleted_at = coalesce(deleted_at, now()),
              metadata = metadata || ${tx.json({ ingestState: "rejected" })}, updated_at = now()
            where org_id = ${row.org_id} and id = ${row.object_id}
          `;
        });
        cleaned += 1;
      } catch (error) {
        await this.phase(row.org_id, row.owner_actor_id ?? undefined, async (tx) => {
          await tx`
            update mail_attachment_ingestions set last_cleanup_error = ${errorMessage(error)},
              updated_at = now() where org_id = ${row.org_id} and id = ${row.id}
          `;
        });
      }
    }
    return cleaned;
  }

  private phase<T>(
    orgId: string,
    actorId: string | undefined,
    callback: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return withTenantIoSagaPostgresContext(
      this.sql,
      { orgId, ...(actorId === undefined ? { serviceContext: true } : { actorId }) },
      callback,
    );
  }

  private async reject(
    orgId: string,
    actorId: string | undefined,
    stageId: string,
    objectId: string,
    reason: string,
  ): Promise<void> {
    await this.phase(orgId, actorId, async (tx) => {
      await tx`
        update mail_attachment_ingestions set status = 'rejected', failure_reason = ${reason},
          rejected_at = now(), updated_at = now()
        where org_id = ${orgId} and id = ${stageId} and status <> 'attached'
      `;
      await tx`
        update objects set metadata = metadata || ${tx.json({ ingestState: "rejected" })},
          updated_at = now() where org_id = ${orgId} and id = ${objectId}
      `;
    });
  }

  private async deleteAndMarkCleaned(
    orgId: string,
    actorId: string | undefined,
    stageId: string,
    objectId: string,
    storageKey: string,
  ): Promise<void> {
    const storage = await this.options.storageResolver({ orgId });
    if (storage === undefined) return;
    try {
      await storage.client.delete(storageKey);
      await this.phase(orgId, actorId, async (tx) => {
        await tx`
          update mail_attachment_ingestions set cleaned_at = now(), last_cleanup_error = null,
            updated_at = now() where org_id = ${orgId} and id = ${stageId} and status = 'rejected'
        `;
        await tx`
          update objects set deleted_at = coalesce(deleted_at, now()), updated_at = now()
          where org_id = ${orgId} and id = ${objectId}
        `;
      });
    } catch (error) {
      await this.phase(orgId, actorId, async (tx) => {
        await tx`
          update mail_attachment_ingestions set last_cleanup_error = ${errorMessage(error)},
            expires_at = ${new Date((this.options.now?.() ?? new Date()).getTime() + CLEANUP_RETRY_MS)},
            updated_at = now() where org_id = ${orgId} and id = ${stageId}
        `;
      });
    }
  }
}

async function readAuthoritativeObject(
  storage: NonNullable<Awaited<ReturnType<TenantStorageResolver>>>["client"],
  key: string,
  expectedSize: number,
): Promise<{
  readonly bytes: Buffer;
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType: string;
}> {
  const [head, object] = await Promise.all([storage.head?.(key), storage.get(key)]);
  if (object === null || object.key !== key)
    throw new MailAttachmentRejectedError("Mail attachment upload is missing.");
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of asIterable(object.body)) {
    byteSize += chunk.byteLength;
    if (byteSize > expectedSize)
      throw new MailAttachmentRejectedError("Mail attachment upload exceeds its declared size.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, byteSize);
  return {
    bytes,
    byteSize: head?.byteSize ?? byteSize,
    sha256: sha256(bytes),
    mimeType: head?.contentType ?? object.contentType ?? "application/octet-stream",
  };
}

async function* asIterable(body: Uint8Array | AsyncIterable<Uint8Array>) {
  if (body instanceof Uint8Array) yield body;
  else yield* body;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

function withoutContent(attachment: MailAttachmentInput, objectId: string): MailAttachmentInput {
  const { content: _content, ...metadata } = attachment;
  return { ...metadata, objectId };
}

export class MailAttachmentCleanupWorker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ingestor: Pick<PostgresMailAttachmentIngestor, "cleanupAbandoned">,
    private readonly intervalMs = CLEANUP_RETRY_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    await this.ingestor.cleanupAbandoned().catch(this.onError);
  }
}
