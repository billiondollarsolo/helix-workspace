import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
} from "../../api/api-error.js";
import { unauthenticatedActor } from "../../api/actor.js";
import {
  commitStorageUsage,
  isActiveBrowserContent,
  isNoopVirusScanner,
  resolveEffectiveMime,
  safeDriveContentHeaders,
  sniffMimeType,
  type DriveStore,
  type VirusScanner,
} from "../drive/index.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type { ChatAttachmentRecord } from "./types.js";
import { dlpDecisionError, type DlpGuard } from "../dlp.js";

export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_STAGE_TTL_MS = 60 * 60 * 1000;
export const CHAT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

const acceptedMimeTypes = new Set<string>(CHAT_ATTACHMENT_MIME_TYPES);
const attachmentParamsSchema = z.object({ objectId: z.string().uuid() }).strict();
const uploadParamsSchema = z.object({ roomId: z.string().uuid() }).strict();
const uploadQuerySchema = z.object({ filename: z.string().min(1).max(255).optional() }).strict();
const contentQuerySchema = z.object({ download: z.enum(["0", "1"]).default("0") }).strict();

interface ChatAttachmentRow {
  readonly object_id: string;
  readonly org_id: string;
  readonly room_id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly byte_size: number | string;
  readonly sha256: string;
  readonly storage_key: string;
}

export interface ChatAttachmentContent extends ChatAttachmentRecord {
  readonly bytes: Uint8Array;
}

export interface ChatAttachmentStore {
  upload(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly filename: string;
    readonly declaredMimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ChatAttachmentRecord>;
  open(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<ChatAttachmentContent>;
  saveToDrive(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<{ readonly objectId: string }>;
}

export class ChatAttachmentRejectedError extends UnprocessableError {
  constructor(message: string) {
    super(message);
    this.name = "ChatAttachmentRejectedError";
  }
}

export class ChatAttachmentNotFoundError extends NotFoundError {
  constructor() {
    super("Chat attachment not found.");
    this.name = "ChatAttachmentNotFoundError";
  }
}

export class PostgresChatAttachmentStore implements ChatAttachmentStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: {
      readonly storageResolver: TenantStorageResolver;
      readonly virusScanner?: VirusScanner | undefined;
      readonly driveStore?: Pick<DriveStore, "prepareUpload" | "finalizeUpload"> | undefined;
      readonly now?: (() => Date) | undefined;
    },
  ) {}

  async upload(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly filename: string;
    readonly declaredMimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ChatAttachmentRecord> {
    const bytes = Buffer.from(input.bytes);
    const filename = safeFilename(input.filename);
    const mimeType = inspectImage(filename, input.declaredMimeType, bytes);
    await this.phase(input.orgId, input.actorId, (tx) => requireRoomAccess(tx, input));
    const scanner = this.options.virusScanner;
    if (scanner === undefined || isNoopVirusScanner(scanner)) {
      throw new ChatAttachmentRejectedError("Chat attachment scanning is unavailable.");
    }
    const verdict = await scanner.scan(bytes);
    if (!verdict.clean) {
      throw new ChatAttachmentRejectedError(
        `Chat attachment failed antivirus scanning: ${verdict.signature ?? "unsafe content"}.`,
      );
    }

    const storage = await this.options.storageResolver({ orgId: input.orgId });
    if (storage === undefined) {
      throw new ApiError("internal_error", "Chat attachment storage is unavailable.");
    }
    if (storage.encryptionAtRest === undefined) {
      throw new ChatAttachmentRejectedError("Chat attachment storage encryption is unavailable.");
    }
    const objectId = randomUUID();
    const digest = sha256(bytes);
    const storageKey = `chat/attachments/${input.roomId}/${objectId}/${digest}`;
    const scannedAt = this.options.now?.() ?? new Date();
    const expiresAt = new Date(scannedAt.getTime() + CHAT_ATTACHMENT_STAGE_TTL_MS);

    await this.phase(input.orgId, input.actorId, async (tx) => {
      await requireRoomAccess(tx, input);
      await tx`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
        ) values (
          ${objectId}, ${input.orgId}, ${input.actorId}, 'chat_attachment', ${storageKey},
          ${mimeType}, ${bytes.byteLength}, ${digest},
          ${tx.json({ status: "staging", namespace: "chat_attachment", roomId: input.roomId })}
        )
      `;
      await tx`
        insert into chat_attachments (
          object_id, org_id, room_id, owner_actor_id, filename, mime_type,
          byte_size, sha256, status, scanned_at, expires_at
        ) values (
          ${objectId}, ${input.orgId}, ${input.roomId}, ${input.actorId}, ${filename},
          ${mimeType}, ${bytes.byteLength}, ${digest}, 'staging', ${scannedAt}, ${expiresAt}
        )
      `;
      await tx`
        insert into drive_quarantine_deletions (
          org_id, object_id, actor_id, storage_key, status, next_attempt_at
        ) values (
          ${input.orgId}, ${objectId}, ${input.actorId}, ${storageKey}, 'pending', ${expiresAt}
        )
        on conflict (org_id, storage_key) do update set
          object_id = excluded.object_id, actor_id = excluded.actor_id, status = 'pending',
          next_attempt_at = excluded.next_attempt_at, lease_expires_at = null,
          completed_at = null, updated_at = now()
      `;
      await commitStorageUsage(tx, input.orgId, objectId, bytes.byteLength, "chat");
    });

    try {
      await storage.client.put({
        key: storageKey,
        body: bytes,
        contentType: mimeType,
        metadata: { objectId, roomId: input.roomId, sha256: digest },
      });
      await this.phase(input.orgId, input.actorId, async (tx) => {
        const rows = await tx<{ readonly object_id: string }[]>`
          update chat_attachments set status = 'ready', updated_at = now()
          where org_id = ${input.orgId} and object_id = ${objectId}
            and owner_actor_id = ${input.actorId} and status = 'staging'
          returning object_id
        `;
        if (rows[0] === undefined) throw new Error("Chat attachment stage changed during upload.");
        await tx`
          update objects set metadata = metadata || ${tx.json({ status: "ready" })}, updated_at = now()
          where org_id = ${input.orgId} and id = ${objectId}
        `;
      });
    } catch (error) {
      await this.rejectAndQueue(
        input.orgId,
        input.actorId,
        objectId,
        storageKey,
        bytes.byteLength,
        error,
      );
      throw error;
    }

    return {
      objectId,
      source: "chat",
      filename,
      mimeType,
      byteSize: bytes.byteLength,
    };
  }

  async open(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<ChatAttachmentContent> {
    const row = await this.phase(input.orgId, input.actorId, async (tx) => {
      const rows = await tx<ChatAttachmentRow[]>`
        select attachment.object_id, attachment.org_id, attachment.room_id,
          attachment.filename, attachment.mime_type, attachment.byte_size,
          attachment.sha256, object.storage_key
        from chat_attachments attachment
        join objects object
          on object.org_id = attachment.org_id and object.id = attachment.object_id
        left join messages message
          on message.org_id = attachment.org_id
          and message.id = attachment.message_id
          and message.kind = 'chat'
        where attachment.org_id = ${input.orgId}
          and attachment.object_id = ${input.objectId}
          and attachment.status = 'ready'
          and object.deleted_at is null
          and (
            (attachment.message_id is not null and message.deleted_at is null)
            or (
              attachment.owner_actor_id = ${input.actorId}
              and attachment.expires_at > statement_timestamp()
            )
          )
          and helix_chat_attachment_room_access(
            attachment.org_id, ${input.actorId}, attachment.room_id
          )
        limit 1
      `;
      return rows[0];
    });
    if (row === undefined) throw new ChatAttachmentNotFoundError();
    const storage = await this.options.storageResolver({ orgId: input.orgId });
    const stored = await storage?.client.get(row.storage_key);
    if (stored === undefined || stored === null) throw new ChatAttachmentNotFoundError();
    const expectedSize = databaseBytes(row.byte_size);
    const bytes = await collectBody(stored.body, expectedSize);
    if (bytes.byteLength !== expectedSize || sha256(bytes) !== row.sha256) {
      throw new ChatAttachmentNotFoundError();
    }
    return {
      objectId: row.object_id,
      source: "chat",
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: expectedSize,
      bytes,
    };
  }

  async saveToDrive(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<{ readonly objectId: string }> {
    if (this.options.driveStore === undefined) {
      throw new ApiError("internal_error", "Drive storage is unavailable.");
    }
    const attachment = await this.open(input);
    const digest = sha256(attachment.bytes);
    const prepared = await this.options.driveStore.prepareUpload({
      orgId: input.orgId,
      actorId: input.actorId,
      name: attachment.filename,
      folderId: null,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      sha256: digest,
      metadata: { sourceChatAttachmentId: attachment.objectId },
    });
    await this.options.driveStore.finalizeUpload({
      orgId: input.orgId,
      actorId: input.actorId,
      objectId: prepared.objectId,
      byteSize: attachment.byteSize,
      sha256: digest,
      mimeType: attachment.mimeType,
      content: attachment.bytes,
      metadata: { sourceChatAttachmentId: attachment.objectId },
    });
    return { objectId: prepared.objectId };
  }

  private phase<T>(
    orgId: string,
    actorId: string,
    callback: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return withTenantIoSagaPostgresContext(this.sql, { orgId, actorId }, callback);
  }

  private async rejectAndQueue(
    orgId: string,
    actorId: string,
    objectId: string,
    storageKey: string,
    byteSize: number,
    error: unknown,
  ): Promise<void> {
    const reason = errorMessage(error);
    await this.phase(orgId, actorId, async (tx) => {
      await tx`
        update chat_attachments set status = 'rejected', failure_reason = ${reason}, updated_at = now()
        where org_id = ${orgId} and object_id = ${objectId} and message_id is null
      `;
      await tx`
        update objects set deleted_at = coalesce(deleted_at, now()),
          metadata = metadata || ${tx.json({ status: "rejected" })}, updated_at = now()
        where org_id = ${orgId} and id = ${objectId}
      `;
      await tx`
        update drive_quarantine_deletions set status = 'pending', next_attempt_at = now(),
          lease_expires_at = null, completed_at = null, last_error = ${reason}, updated_at = now()
        where org_id = ${orgId} and storage_key = ${storageKey}
      `;
      await commitStorageUsage(tx, orgId, objectId, -byteSize, "chat");
    }).catch(() => undefined);
  }
}

export interface RegisterChatAttachmentRoutesOptions {
  readonly store: ChatAttachmentStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly dlp?: DlpGuard;
}

export async function registerChatAttachmentRoutes(
  app: FastifyInstance,
  options: RegisterChatAttachmentRoutesOptions,
): Promise<void> {
  for (const mimeType of [...CHAT_ATTACHMENT_MIME_TYPES, "application/octet-stream"]) {
    safeAddBufferParser(app, mimeType);
  }

  app.post(
    "/api/chat/rooms/:roomId/attachments",
    { bodyLimit: CHAT_ATTACHMENT_MAX_BYTES },
    async (request, reply) => {
      const actor = await requireActor(request, options.actorFromRequest);
      const { roomId } = uploadParamsSchema.parse(request.params);
      const query = uploadQuerySchema.parse(request.query);
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        throw new BadRequestError("Chat attachment bytes are required.");
      }
      await enforceAttachmentDlp(options.dlp, reply, {
        orgId: actor.orgId,
        actorId: actor.id,
        boundary: "chat_attachment",
        content: request.body,
        traceId: request.id,
      });
      const attachment = await options.store.upload({
        orgId: actor.orgId,
        actorId: actor.id,
        roomId,
        filename: query.filename ?? "pasted-image",
        declaredMimeType: headerValue(request.headers["content-type"]),
        bytes: request.body,
      });
      return reply.code(201).send(attachment);
    },
  );

  app.get("/api/chat/attachments/:objectId/content", async (request, reply) => {
    const actor = await requireActor(request, options.actorFromRequest);
    const { objectId } = attachmentParamsSchema.parse(request.params);
    const { download } = contentQuerySchema.parse(request.query);
    const attachment = await options.store.open({
      orgId: actor.orgId,
      actorId: actor.id,
      objectId,
    });
    await enforceAttachmentDlp(options.dlp, reply, {
      orgId: actor.orgId,
      actorId: actor.id,
      boundary: "chat_attachment",
      content: attachment.bytes,
      resourceId: objectId,
      traceId: request.id,
    });
    const headers = safeDriveContentHeaders(
      attachment.filename,
      attachment.mimeType,
      download !== "1",
    );
    return reply
      .header("cache-control", "private, no-store")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cross-origin-resource-policy", "same-origin")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", headers.disposition)
      .type(headers.mimeType)
      .send(Buffer.from(attachment.bytes));
  });

  app.post("/api/chat/attachments/:objectId/save-to-drive", async (request, reply) => {
    const actor = await requireActor(request, options.actorFromRequest);
    const { objectId } = attachmentParamsSchema.parse(request.params);
    return reply
      .code(201)
      .send(await options.store.saveToDrive({ orgId: actor.orgId, actorId: actor.id, objectId }));
  });
}

async function enforceAttachmentDlp(
  guard: DlpGuard | undefined,
  reply: { header(name: string, value: string): unknown },
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly boundary: "chat_attachment";
    readonly content: unknown;
    readonly resourceId?: string;
    readonly traceId?: string;
  },
): Promise<void> {
  if (guard === undefined) return;
  const decision = await guard.evaluate({
    ...input,
    ...(input.resourceId === undefined
      ? {}
      : { resources: [{ resourceType: "drive.file", resourceId: input.resourceId }] }),
  });
  if (decision.action === "block" || decision.action === "quarantine") {
    throw dlpDecisionError(decision);
  }
  if (decision.action === "warn") reply.header("x-helix-dlp-warning", decision.classification);
}

export function inspectImage(
  filename: string,
  declaredMimeType: string,
  bytes: Uint8Array,
): string {
  if (bytes.byteLength === 0 || bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new ChatAttachmentRejectedError("Chat images must be between 1 byte and 10 MiB.");
  }
  const declared = declaredMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const sniffed = sniffMimeType(bytes);
  const effective = resolveEffectiveMime(declared, sniffed);
  if (
    sniffed === null ||
    !acceptedMimeTypes.has(sniffed) ||
    !acceptedMimeTypes.has(effective) ||
    (declared !== "application/octet-stream" && declared !== "" && declared !== sniffed) ||
    isActiveBrowserContent(filename, effective)
  ) {
    throw new ChatAttachmentRejectedError(
      "Only verified PNG, JPEG, GIF, or WebP images are allowed.",
    );
  }
  return effective;
}

async function requireRoomAccess(
  sql: postgres.TransactionSql,
  input: { readonly orgId: string; readonly actorId: string; readonly roomId: string },
): Promise<void> {
  const rows = await sql<{ readonly allowed: boolean }[]>`
    select helix_chat_attachment_room_access(
      ${input.orgId}, ${input.actorId}, ${input.roomId}
    ) as allowed
  `;
  if (rows[0]?.allowed !== true) throw new NotFoundError("Chat room not found.");
}

async function requireActor(
  request: FastifyRequest,
  resolve: RegisterChatAttachmentRoutesOptions["actorFromRequest"],
): Promise<Actor> {
  const actor = await resolve(request);
  if (actor.id === unauthenticatedActor.id || actor.id === "anonymous") {
    throw new UnauthorizedError("A browser session is required for Chat attachments.");
  }
  return actor;
}

function safeAddBufferParser(app: FastifyInstance, mimeType: string): void {
  if (app.hasContentTypeParser(mimeType)) return;
  app.addContentTypeParser(mimeType, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
}

function safeFilename(value: string): string {
  const leaf = value
    .split(/[\\/]/u)
    .at(-1)
    ?.replaceAll(/\p{Cc}/gu, "")
    .trim();
  return (leaf === undefined || leaf.length === 0 ? "pasted-image" : leaf).slice(0, 255);
}

async function collectBody(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  expectedSize: number,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > expectedSize) throw new ChatAttachmentNotFoundError();
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > expectedSize) throw new ChatAttachmentNotFoundError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function databaseBytes(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new ChatAttachmentNotFoundError();
  }
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

function headerValue(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : (value?.[0] ?? "");
}
