import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { insertNotification } from "../notifications/store.js";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type { TenantStorageResolver } from "../storage/index.js";
import { exportDocsDocument } from "./export/index.js";
import {
  HELIX_NATIVE_DOCUMENT_ENGINE,
  createNativeDocumentState,
  documentStateFromStoredUpdates,
  documentTextFromStoredState,
  type NativeDocumentTextSelection,
  replaceFirstTextInStoredState,
  stateVectorFromStoredState,
} from "./native-state.js";
import type {
  DocsCommentProjection,
  DocsAskHistoryRecord,
  DocsAskSourceScope,
  DocsCommentListItem,
  DocsCommentRecord,
  DocsDocumentRecord,
  DocsEditorEngine,
  DocsExportDocument,
  DocsExportFormat,
  DocsExportRecord,
  DocsExportStore,
  DocsOutlineEnrichmentRecord,
  DocsOutlineEnrichmentStore,
  DocsOutlineItem,
  DocsSearchProjectionStore,
  DocsSearchRecord,
  DocsSuggestionRecord,
  DocsSuggestionStatus,
  DocsUpdateRecord,
  DocsVersionDiffLine,
  DocsVersionPreviewRecord,
  DocsVersionRestoreRecord,
} from "./types.js";

export interface CreateDocsDocumentInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string;
  readonly initialMarkdown?: string | undefined;
  readonly editorEngine?: DocsEditorEngine | undefined;
  readonly formatVersion?: number | undefined;
  readonly folderId?: string | null | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface AppendDocsUpdateInput {
  readonly orgId: string;
  readonly actorId?: string | null | undefined;
  readonly documentId: string;
  readonly update: Buffer;
  readonly metadata?: JsonObject | undefined;
}

export interface DocsStore extends DocsExportStore {
  create(input: CreateDocsDocumentInput): Promise<DocsDocumentRecord>;
  listDocumentsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit: number;
  }): Promise<readonly DocsDocumentRecord[]>;
  updateTitle(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly title: string;
  }): Promise<DocsDocumentRecord | null>;
  updateLayout(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly layoutSettings: NativeDocumentLayoutSettings;
  }): Promise<DocsDocumentRecord | null>;
  migrateToNativeDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null>;
  export(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly format: DocsExportFormat;
  }): Promise<DocsExportRecord | null>;
  createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsCommentRecord>;
  listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DocsCommentListItem[]>;
  resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null>;
  reopenComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null>;
  updateComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DocsCommentRecord | null>;
  deleteComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null>;
  createSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly beforeText: string;
    readonly afterText: string;
    readonly reason?: string | undefined;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsSuggestionRecord>;
  listSuggestions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: DocsSuggestionStatus | undefined;
  }): Promise<readonly DocsSuggestionRecord[]>;
  listVersions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
    readonly beforeSeq?: number | undefined;
  }): Promise<readonly DocsUpdateRecord[]>;
  nameVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly name: string;
  }): Promise<DocsUpdateRecord | null>;
  previewVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
  }): Promise<DocsVersionPreviewRecord | null>;
  restoreVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq?: number | undefined;
  }): Promise<DocsVersionRestoreRecord | null>;
  resolveSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly suggestionId: string;
    readonly status: "accepted" | "rejected";
  }): Promise<DocsSuggestionRecord | null>;
  resolveSuggestions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly suggestionIds: readonly string[];
    readonly status: "accepted" | "rejected";
  }): Promise<readonly DocsSuggestionRecord[] | null>;
  createAskHistoryItem(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly question: string;
    readonly answer: string;
    readonly sourceScope: DocsAskSourceScope;
    readonly sourceExcerpt: string;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsAskHistoryRecord>;
  listAskHistory(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
  }): Promise<readonly DocsAskHistoryRecord[]>;
  clearAskHistory(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<number>;
  getDocumentForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null>;
  getDocsExportDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }): Promise<DocsExportDocument | null>;
  appendUpdate(input: AppendDocsUpdateInput): Promise<DocsUpdateRecord>;
  compactDocument(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly state: Buffer;
    readonly stateVector?: Buffer | null | undefined;
  }): Promise<DocsDocumentRecord | null>;
}

export interface NativeDocumentLayoutSettings {
  readonly layoutMode: "page" | "pageless";
  readonly columnCount: 1 | 2;
  readonly sections?: readonly NativeDocumentSectionSettings[] | undefined;
}

export interface NativeDocumentSectionSettings {
  readonly id: string;
  readonly title?: string | undefined;
  readonly layoutMode?: "page" | "pageless" | undefined;
  readonly columnCount?: 1 | 2 | undefined;
  readonly pageSize?: "letter" | "a4" | undefined;
  readonly orientation?: "portrait" | "landscape" | undefined;
}

interface DocsDocumentRow {
  readonly id: string;
  readonly org_id: string;
  readonly title: string;
  readonly thread_id: string | null;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly ydoc_state: Buffer | null;
  readonly ydoc_state_vector: Buffer | null;
  readonly update_seq: number;
  readonly editor_engine: string;
  readonly format_version: number;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DocsUpdateRow {
  readonly id: string;
  readonly org_id: string;
  readonly document_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly seq: number;
  readonly update: Buffer;
  readonly metadata: JsonObject;
  readonly created_at: Date;
}

interface DocsCommentRow {
  readonly id: string;
  readonly org_id: string;
  readonly document_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DocsCommentProjectionRow extends DocsCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

interface DocsSuggestionRow {
  readonly id: string;
  readonly org_id: string;
  readonly document_id: string;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly before_text: string;
  readonly after_text: string;
  readonly reason: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_by_actor_id: string | null;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DocsAskHistoryRow {
  readonly id: string;
  readonly org_id: string;
  readonly document_id: string;
  readonly actor_id: string;
  readonly question: string;
  readonly answer: string;
  readonly source_scope: DocsAskSourceScope;
  readonly source_excerpt: string;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DocsSearchProjectionRow extends DocsDocumentRow {
  readonly owner_display_name: string | null;
  readonly owner_email: string | null;
}

interface DocsActorRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly email: string | null;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export interface PostgresDocsStoreOptions {
  readonly storageResolver?: TenantStorageResolver | undefined;
}

const docsDocumentMimeType = "application/vnd.helix.document";

export class PostgresDocsStore
  implements DocsStore, DocsSearchProjectionStore, DocsOutlineEnrichmentStore
{
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresDocsStoreOptions = {},
  ) {}

  async create(input: CreateDocsDocumentInput): Promise<DocsDocumentRecord> {
    return this.sql.begin(async (tx) => {
      const threadRows = (await tx`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'doc', ${input.title}, ${input.actorId}, ${tx.json(toSqlJson({ documentTitle: input.title }))})
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const threadId = threadRows[0]?.id;
      if (threadId === undefined) {
        throw new Error("Unable to create docs thread.");
      }

      const initialState =
        input.editorEngine === HELIX_NATIVE_DOCUMENT_ENGINE
          ? createNativeDocumentState(input.initialMarkdown ?? "")
          : {
              state: Buffer.from(input.initialMarkdown ?? "", "utf8"),
              stateVector: null,
            };
      const documentRows = (await tx`
        insert into docs_documents (
          org_id, title, thread_id, owner_actor_id, created_by_actor_id, ydoc_state, ydoc_state_vector, update_seq, editor_engine, format_version, metadata
        )
        values (
          ${input.orgId},
          ${input.title},
          ${threadId},
          ${input.actorId},
          ${input.actorId},
          ${initialState.state},
          ${initialState.stateVector},
          0,
          ${input.editorEngine ?? "legacy-yjs"},
          ${input.formatVersion ?? 1},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const document = mapDocument(documentRows[0]);
      const storageKey = docsDocumentStorageKey(input.orgId, document.id);
      const stateSha256 = sha256Hex(initialState.state);
      const driveMetadata = toSqlJson({
        ...(input.metadata ?? {}),
        app: "docs",
        docId: document.id,
        name: `${input.title}.helixdoc`,
        title: input.title,
        folderId: input.folderId ?? null,
        editorEngine: input.editorEngine ?? "legacy-yjs",
        formatVersion: input.formatVersion ?? 1,
      });

      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${document.id},
          ${input.orgId},
          ${input.actorId},
          'file',
          ${storageKey},
          ${docsDocumentMimeType},
          ${initialState.state.byteLength},
          ${stateSha256},
          ${tx.json(driveMetadata)}
        )
        on conflict (id) do update set
          storage_key = excluded.storage_key,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          metadata = excluded.metadata,
          updated_at = now()
      `;
      await this.persistDocumentState({
        orgId: input.orgId,
        documentId: document.id,
        storageKey,
        state: initialState.state,
        sha256: stateSha256,
      });

      await grantDocumentAccess(tx, {
        orgId: input.orgId,
        documentId: document.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await grantThreadAccess(tx, {
        orgId: input.orgId,
        threadId,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        objectId: document.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.document.created",
        documentId: document.id,
        payload: { title: input.title, threadId },
      });

      return document;
    });
  }

  async listDocumentsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly limit: number;
  }): Promise<readonly DocsDocumentRecord[]> {
    const query = input.query?.trim();
    const titleQuery = query === undefined || query.length === 0 ? null : `%${query}%`;
    const rows = (await this.sql`
      select *
      from docs_documents
      where org_id = ${input.orgId}
        and deleted_at is null
        and (
          owner_actor_id = ${input.actorId}
          or created_by_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'document'
              and p.resource_id = docs_documents.id
              and p.org_id = ${input.orgId}
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
        and (${titleQuery}::text is null or title ilike ${titleQuery})
      order by updated_at desc
      limit ${input.limit}
    `) as unknown as readonly DocsDocumentRow[];
    return rows.map(mapDocument);
  }

  async updateTitle(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly title: string;
  }): Promise<DocsDocumentRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      const rows = (await tx`
        update docs_documents
        set title = ${input.title}, updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const document = rows[0] === undefined ? null : mapDocument(rows[0]);
      if (document !== null) {
        await tx`
          update threads
          set subject = ${input.title}, updated_at = now()
          where id = ${document.threadId}
            and org_id = ${input.orgId}
        `;
        await tx`
          update objects
          set
            metadata = jsonb_set(
              jsonb_set(metadata, '{name}', to_jsonb(${`${input.title}.helixdoc`}::text), true),
              '{title}',
              to_jsonb(${input.title}::text),
              true
            ),
            updated_at = now()
          where id = ${input.documentId}
            and org_id = ${input.orgId}
            and metadata->>'app' = 'docs'
        `;
        await appendDocsActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "docs.document.title_updated",
          documentId: input.documentId,
          payload: { title: input.title },
        });
      }
      return document;
    });
  }

  async updateLayout(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly layoutSettings: NativeDocumentLayoutSettings;
  }): Promise<DocsDocumentRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      const rows = (await tx`
        update docs_documents
        set
          metadata = jsonb_set(
            metadata,
            '{nativeDocumentLayout}',
            ${tx.json(toSqlJson(input.layoutSettings))}::jsonb,
            true
          ),
          updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const document = rows[0] === undefined ? null : mapDocument(rows[0]);
      if (document !== null) {
        await appendDocsActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "docs.document.layout_updated",
          documentId: input.documentId,
          payload: {
            layoutSettings: {
              layoutMode: input.layoutSettings.layoutMode,
              columnCount: input.layoutSettings.columnCount,
            },
          },
        });
      }
      return document;
    });
  }

  async export(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly format: DocsExportFormat;
  }): Promise<DocsExportRecord | null> {
    const document = await this.getDocumentForActor(input);
    if (document === null) {
      return null;
    }
    const exported = exportDocsDocument({
      document: {
        id: document.id,
        orgId: document.orgId,
        title: document.title,
        markdown: documentTextFromStoredState(document.ydocState),
        updatedAt: document.updatedAt,
        metadata: document.metadata,
      },
      format: input.format,
    });
    return {
      documentId: document.id,
      title: document.title,
      format: input.format,
      filename: exported.filename,
      mimeType: exported.mimeType,
      contentBase64: exported.contentBase64,
      exportedAt: new Date(),
    };
  }

  async migrateToNativeDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectDocumentForActor(
        tx,
        input.orgId,
        input.actorId,
        input.documentId,
      );
      if (existing === null) {
        return null;
      }
      if (existing.editorEngine === HELIX_NATIVE_DOCUMENT_ENGINE && existing.formatVersion === 1) {
        return existing;
      }

      const text = documentTextFromStoredState(existing.ydocState);
      const nativeState = createNativeDocumentState(text);
      const storageKey = docsDocumentStorageKey(input.orgId, input.documentId);
      const stateSha256 = sha256Hex(nativeState.state);
      const rows = (await tx`
        update docs_documents
        set
          ydoc_state = ${nativeState.state},
          ydoc_state_vector = ${nativeState.stateVector},
          update_seq = update_seq + 1,
          editor_engine = ${HELIX_NATIVE_DOCUMENT_ENGINE},
          format_version = 1,
          metadata = metadata || ${tx.json(
            toSqlJson({
              migratedFromEditorEngine: existing.editorEngine,
              migratedFromFormatVersion: existing.formatVersion,
            }),
          )}::jsonb,
          updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const migrated = rows[0] === undefined ? null : mapDocument(rows[0]);
      if (migrated === null) {
        return null;
      }
      await tx`
        insert into docs_updates (org_id, document_id, actor_id, seq, update, metadata)
        values (
          ${input.orgId},
          ${input.documentId},
          ${input.actorId},
          ${migrated.updateSeq},
          ${nativeState.state},
          ${tx.json(
            toSqlJson({
              source: "docs.migrate-native",
              migratedFromEditorEngine: existing.editorEngine,
              migratedFromFormatVersion: existing.formatVersion,
              stateBase64: nativeState.state.toString("base64"),
            }),
          )}
        )
      `;
      await tx`
        update objects
        set
          storage_key = ${storageKey},
          mime_type = ${docsDocumentMimeType},
          byte_size = ${nativeState.state.byteLength},
          sha256 = ${stateSha256},
          metadata = metadata || ${tx.json(
            toSqlJson({
              app: "docs",
              docId: input.documentId,
              editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
              formatVersion: 1,
              migratedFromEditorEngine: existing.editorEngine,
            }),
          )}::jsonb,
          updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and metadata->>'app' = 'docs'
      `;
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.document.migrated_native",
        documentId: input.documentId,
        payload: {
          migratedFromEditorEngine: existing.editorEngine,
          migratedFromFormatVersion: existing.formatVersion,
        },
      });
      await this.persistDocumentState({
        orgId: input.orgId,
        documentId: input.documentId,
        storageKey,
        state: nativeState.state,
        sha256: stateSha256,
      });
      return migrated;
    });
  }

  async getDocsSearchRecord(docId: string): Promise<DocsSearchRecord | null> {
    const documentRows = (await this.sql`
      select
        d.*,
        a.display_name as owner_display_name,
        a.email as owner_email
      from docs_documents d
      left join actors a on a.id = d.owner_actor_id and a.org_id = d.org_id
      where d.id = ${docId}
      limit 1
    `) as unknown as readonly DocsSearchProjectionRow[];
    const document = documentRows[0];
    if (document === undefined) {
      return null;
    }

    const comments = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from docs_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${document.org_id}
        and c.document_id = ${docId}
        and c.status = 'open'
      order by c.created_at asc
    `) as unknown as readonly DocsCommentProjectionRow[];

    const collaborators = (await this.sql`
      select distinct a.id, a.display_name, a.email
      from permissions p
      join actors a on a.id = p.actor_id and a.org_id = p.org_id
      where p.org_id = ${document.org_id}
        and p.resource_type = 'document'
        and p.resource_id = ${docId}
        and (p.expires_at is null or p.expires_at > now())
        and (${document.owner_actor_id ?? null}::uuid is null or p.actor_id <> ${document.owner_actor_id ?? null})
      order by a.display_name asc
    `) as unknown as readonly DocsActorRow[];

    return mapDocsSearchRecord(document, comments, collaborators);
  }

  async getDocsOutlineEnrichmentRecord(docId: string): Promise<DocsOutlineEnrichmentRecord | null> {
    const record = await this.getDocsSearchRecord(docId);
    if (record === null) {
      return null;
    }
    return {
      id: record.id,
      title: record.title,
      ...(record.markdown === undefined ? {} : { markdown: record.markdown }),
      ...(record.plainText === undefined ? {} : { plainText: record.plainText }),
      ...(record.html === undefined ? {} : { html: record.html }),
      body: record.markdown ?? record.plainText ?? record.title,
      ...(record.outline === undefined ? {} : { outline: record.outline }),
      ...(record.classification === undefined ? {} : { classification: record.classification }),
      ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    };
  }

  async recordDocsOutlineEnrichment(input: {
    readonly docId: string;
    readonly outline: readonly DocsOutlineItem[];
    readonly summary?: string | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<void> {
    await this.sql`
      update docs_documents
      set
        metadata = metadata || ${this.sql.json(
          toSqlJson({
            outline: input.outline,
            ...(input.summary === undefined ? {} : { outlineSummary: input.summary }),
            outlineEnrichment: {
              ...(input.metadata ?? {}),
              updatedAt: new Date().toISOString(),
            },
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${input.docId}
    `;
  }

  async createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsCommentRecord> {
    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      if (input.parentCommentId !== undefined) {
        await requireCommentParent(tx, {
          orgId: input.orgId,
          documentId: input.documentId,
          parentCommentId: input.parentCommentId,
        });
      }
      const rows = (await tx`
        insert into docs_comments
          (org_id, document_id, parent_comment_id, actor_id, anchor, body, metadata)
        values (
          ${input.orgId},
          ${input.documentId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DocsCommentRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.comment.created",
        documentId: input.documentId,
        payload: { commentId: rows[0]?.id ?? null },
      });
      const comment = mapComment(rows[0]);
      await notifyCommentMentions(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        documentId: input.documentId,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        body: input.body,
        metadata: input.metadata ?? {},
      });
      return comment;
    });
  }

  async listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DocsCommentListItem[]> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const rows = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from docs_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.document_id = ${input.documentId}
        ${
          input.status === undefined || input.status === "all"
            ? this.sql``
            : this.sql`and c.status = ${input.status}`
        }
      order by c.created_at asc, c.id asc
    `) as unknown as readonly DocsCommentProjectionRow[];
    return rows.map(mapCommentListItem);
  }

  async resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from docs_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DocsCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, existing.document_id);
      if (existing.status === "resolved") {
        return mapComment(existing);
      }
      const rows = (await tx`
        update docs_comments
        set status = 'resolved', resolved_at = now(), updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DocsCommentRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.comment.resolved",
        documentId: existing.document_id,
        payload: { commentId: input.commentId },
      });
      return rows[0] === undefined ? null : mapComment(rows[0]);
    });
  }

  async reopenComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from docs_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DocsCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, existing.document_id);
      if (existing.status === "open") {
        return mapComment(existing);
      }
      const rows = (await tx`
        update docs_comments
        set status = 'open', resolved_at = null, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DocsCommentRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.comment.reopened",
        documentId: existing.document_id,
        payload: { commentId: input.commentId },
      });
      return rows[0] === undefined ? null : mapComment(rows[0]);
    });
  }

  async updateComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DocsCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from docs_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DocsCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, existing.document_id);
      const rows = (await tx`
        update docs_comments
        set body = ${input.body}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DocsCommentRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.comment.updated",
        documentId: existing.document_id,
        payload: { commentId: input.commentId },
      });
      return rows[0] === undefined ? null : mapComment(rows[0]);
    });
  }

  async deleteComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DocsCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from docs_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DocsCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, existing.document_id);
      const rows = (await tx`
        delete from docs_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DocsCommentRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.comment.deleted",
        documentId: existing.document_id,
        payload: { commentId: input.commentId },
      });
      return rows[0] === undefined ? null : mapComment(rows[0]);
    });
  }

  async createSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly beforeText: string;
    readonly afterText: string;
    readonly reason?: string | undefined;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsSuggestionRecord> {
    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      const rows = (await tx`
        insert into docs_suggestions
          (org_id, document_id, actor_id, anchor, before_text, after_text, reason, metadata)
        values (
          ${input.orgId},
          ${input.documentId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.beforeText},
          ${input.afterText},
          ${input.reason ?? ""},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DocsSuggestionRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.suggestion.created",
        documentId: input.documentId,
        payload: { suggestionId: rows[0]?.id ?? null },
      });
      return mapSuggestion(rows[0]);
    });
  }

  async listSuggestions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly status?: DocsSuggestionStatus | undefined;
  }): Promise<readonly DocsSuggestionRecord[]> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const status = input.status ?? null;
    const rows = (await this.sql`
      select *
      from docs_suggestions
      where org_id = ${input.orgId}
        and document_id = ${input.documentId}
        and (${status}::text is null or status = ${status})
      order by created_at asc
    `) as unknown as readonly DocsSuggestionRow[];
    return rows.map(mapSuggestion);
  }

  async resolveSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly suggestionId: string;
    readonly status: "accepted" | "rejected";
  }): Promise<DocsSuggestionRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from docs_suggestions
        where id = ${input.suggestionId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DocsSuggestionRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, existing.document_id);
      if (existing.status !== "pending") {
        return mapSuggestion(existing);
      }

      let appliedState: AppliedSuggestionDocumentState | null = null;
      if (input.status === "accepted") {
        appliedState = await applySuggestionToDocument(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          documentId: existing.document_id,
          beforeText: existing.before_text,
          afterText: existing.after_text,
          anchorSelection: nativeDocumentSuggestionAnchorSelection(existing.anchor),
        });
      }

      const rows = (await tx`
        update docs_suggestions
        set
          status = ${input.status},
          resolved_by_actor_id = ${input.actorId},
          resolved_at = now(),
          updated_at = now()
        where id = ${input.suggestionId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DocsSuggestionRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: `docs.suggestion.${input.status}`,
        documentId: existing.document_id,
        payload: { suggestionId: input.suggestionId },
      });
      if (appliedState !== null) {
        await this.persistAcceptedSuggestionState(tx, appliedState);
      }
      return rows[0] === undefined ? null : mapSuggestion(rows[0]);
    });
  }

  async resolveSuggestions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly suggestionIds: readonly string[];
    readonly status: "accepted" | "rejected";
  }): Promise<readonly DocsSuggestionRecord[] | null> {
    const suggestionIds = [...new Set(input.suggestionIds)];
    if (suggestionIds.length === 0) {
      return [];
    }

    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      const existingRows = (await tx`
        select *
        from docs_suggestions
        where org_id = ${input.orgId}
          and document_id = ${input.documentId}
          and id = any(${tx.array(suggestionIds)}::uuid[])
        for update
      `) as unknown as readonly DocsSuggestionRow[];
      if (existingRows.length !== suggestionIds.length) {
        return null;
      }

      const rowById = new Map(existingRows.map((row) => [row.id, row]));
      const resolved: DocsSuggestionRecord[] = [];
      let latestAppliedState: AppliedSuggestionDocumentState | null = null;
      for (const suggestionId of suggestionIds) {
        const existing = rowById.get(suggestionId);
        if (existing === undefined) {
          return null;
        }
        if (existing.status !== "pending") {
          resolved.push(mapSuggestion(existing));
          continue;
        }

        if (input.status === "accepted") {
          latestAppliedState = await applySuggestionToDocument(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            documentId: existing.document_id,
            beforeText: existing.before_text,
            afterText: existing.after_text,
            anchorSelection: nativeDocumentSuggestionAnchorSelection(existing.anchor),
          });
        }

        const rows = (await tx`
          update docs_suggestions
          set
            status = ${input.status},
            resolved_by_actor_id = ${input.actorId},
            resolved_at = now(),
            updated_at = now()
          where id = ${suggestionId}
            and org_id = ${input.orgId}
            and document_id = ${input.documentId}
          returning *
        `) as unknown as readonly DocsSuggestionRow[];
        await appendDocsActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: `docs.suggestion.${input.status}`,
          documentId: existing.document_id,
          payload: { suggestionId },
        });
        const updated = rows[0];
        if (updated === undefined) {
          return null;
        }
        resolved.push(mapSuggestion(updated));
      }
      if (latestAppliedState !== null) {
        await this.persistAcceptedSuggestionState(tx, latestAppliedState);
      }
      return resolved;
    });
  }

  async createAskHistoryItem(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly question: string;
    readonly answer: string;
    readonly sourceScope: DocsAskSourceScope;
    readonly sourceExcerpt: string;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsAskHistoryRecord> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const rows = (await this.sql`
      insert into docs_ask_history (
        org_id, document_id, actor_id, question, answer, source_scope, source_excerpt, metadata
      )
      values (
        ${input.orgId},
        ${input.documentId},
        ${input.actorId},
        ${input.question},
        ${input.answer},
        ${input.sourceScope},
        ${input.sourceExcerpt},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))}
      )
      returning *
    `) as unknown as readonly DocsAskHistoryRow[];
    return mapAskHistory(rows[0]);
  }

  async listAskHistory(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
  }): Promise<readonly DocsAskHistoryRecord[]> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const rows = (await this.sql`
      select *
      from docs_ask_history
      where org_id = ${input.orgId}
        and document_id = ${input.documentId}
        and actor_id = ${input.actorId}
      order by created_at desc
      limit ${input.limit}
    `) as unknown as readonly DocsAskHistoryRow[];
    return rows.map(mapAskHistory);
  }

  async clearAskHistory(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<number> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const rows = (await this.sql`
      with deleted as (
        delete from docs_ask_history
        where org_id = ${input.orgId}
          and document_id = ${input.documentId}
          and actor_id = ${input.actorId}
        returning id
      )
      select count(*)::integer as count from deleted
    `) as unknown as readonly { readonly count: number }[];
    return rows[0]?.count ?? 0;
  }

  async getDocumentForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
  }): Promise<DocsDocumentRecord | null> {
    return selectDocumentForActor(this.sql, input.orgId, input.actorId, input.documentId);
  }

  async getDocsExportDocument(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
  }): Promise<DocsExportDocument | null> {
    const document = await this.getDocumentForActor({
      orgId: input.orgId,
      actorId: input.actorId,
      documentId: input.docId,
    });
    if (document === null) {
      return null;
    }
    const comments = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from docs_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.document_id = ${input.docId}
        and c.status = 'open'
      order by c.created_at asc
    `) as unknown as readonly DocsCommentProjectionRow[];
    return {
      id: document.id,
      orgId: document.orgId,
      title: document.title,
      markdown: documentTextFromStoredState(document.ydocState),
      comments: comments.map(mapCommentProjection),
      updatedAt: document.updatedAt,
      metadata: document.metadata,
    };
  }

  async appendUpdate(input: AppendDocsUpdateInput): Promise<DocsUpdateRecord> {
    return this.sql.begin(async (tx) => {
      if (input.actorId !== null && input.actorId !== undefined) {
        await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      } else {
        await requireDocumentExists(tx, input.orgId, input.documentId);
      }
      const seqRows = (await tx`
        update docs_documents
        set update_seq = update_seq + 1, updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning update_seq
      `) as unknown as readonly { readonly update_seq: number }[];
      const seq = seqRows[0]?.update_seq;
      if (seq === undefined) {
        throw new Error(`Unknown document: ${input.documentId}`);
      }
      const rows = (await tx`
        insert into docs_updates (org_id, document_id, actor_id, seq, update, metadata)
        values (
          ${input.orgId},
          ${input.documentId},
          ${input.actorId ?? null},
          ${seq},
          ${input.update},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DocsUpdateRow[];
      return mapUpdate(rows[0]);
    });
  }

  async listVersions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly limit: number;
    readonly beforeSeq?: number | undefined;
  }): Promise<readonly DocsUpdateRecord[]> {
    await requireDocumentAccess(this.sql, input.orgId, input.actorId, input.documentId);
    const rows = (await this.sql`
      select *
      from docs_updates
      where org_id = ${input.orgId}
        and document_id = ${input.documentId}
        ${input.beforeSeq === undefined ? this.sql`` : this.sql`and seq < ${input.beforeSeq}`}
      order by seq desc
      limit ${input.limit}
    `) as unknown as readonly DocsUpdateRow[];
    return rows.map(mapUpdate);
  }

  async nameVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly name: string;
  }): Promise<DocsUpdateRecord | null> {
    return this.sql.begin(async (tx) => {
      const versionRows = (await tx`
        select *
        from docs_updates
        where org_id = ${input.orgId}
          and id = ${input.versionId}
        for update
      `) as unknown as readonly DocsUpdateRow[];
      const version = versionRows[0];
      if (version === undefined) {
        return null;
      }
      await requireDocumentAccess(tx, input.orgId, input.actorId, version.document_id);
      const rows = (await tx`
        update docs_updates
        set metadata = metadata || ${tx.json(toSqlJson({ name: input.name }))}::jsonb
        where org_id = ${input.orgId}
          and id = ${input.versionId}
        returning *
      `) as unknown as readonly DocsUpdateRow[];
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.version.named",
        documentId: version.document_id,
        payload: { versionId: input.versionId, name: input.name },
      });
      return rows[0] === undefined ? null : mapUpdate(rows[0]);
    });
  }

  async previewVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
  }): Promise<DocsVersionPreviewRecord | null> {
    const versionRows = (await this.sql`
      select *
      from docs_updates
      where org_id = ${input.orgId}
        and id = ${input.versionId}
      limit 1
    `) as unknown as readonly DocsUpdateRow[];
    const versionRow = versionRows[0];
    if (versionRow === undefined) {
      return null;
    }
    const document = await selectDocumentForActor(
      this.sql,
      input.orgId,
      input.actorId,
      versionRow.document_id,
    );
    if (document === null) {
      throw new Error(`Unknown or inaccessible document: ${versionRow.document_id}`);
    }

    const warnings: string[] = [];
    const snapshotState = stateSnapshotFromMetadata(versionRow.metadata);
    const reconstruction =
      snapshotState === null
        ? await this.reconstructVersionState({
            sql: this.sql,
            orgId: input.orgId,
            documentId: versionRow.document_id,
            seq: versionRow.seq,
            warnings,
          })
        : {
            state: snapshotState,
            appliedCount: 0,
            skippedCount: 0,
            hasBaseline: true,
          };
    const versionText = documentTextFromStoredState(reconstruction.state);
    const currentText = documentTextFromStoredState(document.ydocState);
    return {
      version: mapUpdate(versionRow),
      documentId: versionRow.document_id,
      currentUpdateSeq: document.updateSeq,
      currentText,
      versionText,
      completeness: snapshotState === null ? "reconstructed" : "snapshot",
      complete:
        snapshotState !== null ||
        (reconstruction.hasBaseline &&
          reconstruction.appliedCount > 0 &&
          reconstruction.skippedCount === 0),
      appliedCount: reconstruction.appliedCount,
      skippedCount: reconstruction.skippedCount,
      diff: lineDiff(versionText, currentText),
      warnings,
    };
  }

  private async reconstructVersionState(input: {
    readonly sql: SqlLike;
    readonly orgId: string;
    readonly documentId: string;
    readonly seq: number;
    readonly warnings: string[];
  }): Promise<{
    readonly state: Buffer;
    readonly appliedCount: number;
    readonly skippedCount: number;
    readonly hasBaseline: boolean;
  }> {
    const rows = (await input.sql`
      select *
      from docs_updates
      where org_id = ${input.orgId}
        and document_id = ${input.documentId}
        and seq <= ${input.seq}
      order by seq asc, created_at asc, id asc
    `) as unknown as readonly DocsUpdateRow[];
    const reconstructed = documentStateFromStoredUpdates(rows.map((row) => row.update));
    if (reconstructed.skippedCount > 0) {
      input.warnings.push(
        `${String(reconstructed.skippedCount)} stored update(s) could not be applied.`,
      );
    }
    if (rows.length > 0 && reconstructed.appliedCount === 0) {
      input.warnings.push("No Yjs update payloads were available for this preview.");
    }
    const hasBaseline = rows[0]?.seq === 1;
    if (!hasBaseline) {
      input.warnings.push("This preview has no baseline update and may omit earlier content.");
    }
    return {
      state: reconstructed.state,
      appliedCount: reconstructed.appliedCount,
      skippedCount: reconstructed.skippedCount,
      hasBaseline,
    };
  }

  async restoreVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq?: number | undefined;
  }): Promise<DocsVersionRestoreRecord | null> {
    return this.sql.begin(async (tx) => {
      const versionRows = (await tx`
        select *
        from docs_updates
        where org_id = ${input.orgId}
          and id = ${input.versionId}
        for update
      `) as unknown as readonly DocsUpdateRow[];
      const versionRow = versionRows[0];
      if (versionRow === undefined) {
        return null;
      }
      const document = await selectDocumentForActor(
        tx,
        input.orgId,
        input.actorId,
        versionRow.document_id,
      );
      if (document === null) {
        throw new Error(`Unknown or inaccessible document: ${versionRow.document_id}`);
      }
      if (
        input.expectedCurrentUpdateSeq !== undefined &&
        document.updateSeq !== input.expectedCurrentUpdateSeq
      ) {
        throw new Error("Cannot restore Docs version because the document changed after preview.");
      }

      const warnings: string[] = [];
      const snapshotState = stateSnapshotFromMetadata(versionRow.metadata);
      const reconstruction =
        snapshotState === null
          ? await this.reconstructVersionState({
              sql: tx,
              orgId: input.orgId,
              documentId: versionRow.document_id,
              seq: versionRow.seq,
              warnings,
            })
          : {
              state: snapshotState,
              appliedCount: 0,
              skippedCount: 0,
              hasBaseline: true,
            };
      const complete =
        snapshotState !== null ||
        (reconstruction.hasBaseline &&
          reconstruction.appliedCount > 0 &&
          reconstruction.skippedCount === 0);
      if (!complete) {
        throw new Error("Cannot restore an incomplete Docs version preview.");
      }

      const stateSha256 = sha256Hex(reconstruction.state);
      const stateVector = stateVectorFromStoredState(reconstruction.state);
      const storageKey = docsDocumentStorageKey(input.orgId, versionRow.document_id);
      const seqRows = (await tx`
        update docs_documents
        set
          update_seq = update_seq + 1,
          ydoc_state = ${reconstruction.state},
          ydoc_state_vector = ${stateVector},
          updated_at = now()
        where id = ${versionRow.document_id}
          and org_id = ${input.orgId}
          and deleted_at is null
          ${
            input.expectedCurrentUpdateSeq === undefined
              ? tx``
              : tx`and update_seq = ${input.expectedCurrentUpdateSeq}`
          }
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const restoredRow = seqRows[0];
      if (restoredRow === undefined) {
        throw new Error("Cannot restore Docs version because the document changed after preview.");
      }
      const restoredDocument = mapDocument(restoredRow);
      const restoreRows = (await tx`
        insert into docs_updates (org_id, document_id, actor_id, seq, update, metadata)
        values (
          ${input.orgId},
          ${versionRow.document_id},
          ${input.actorId},
          ${restoredDocument.updateSeq},
          ${reconstruction.state},
          ${tx.json(
            toSqlJson({
              source: "docs.version.restore",
              restoredVersionId: input.versionId,
              restoredSeq: versionRow.seq,
              stateBase64: reconstruction.state.toString("base64"),
            }),
          )}
        )
        returning *
      `) as unknown as readonly DocsUpdateRow[];
      await tx`
        update objects
        set
          storage_key = ${storageKey},
          mime_type = ${docsDocumentMimeType},
          byte_size = ${reconstruction.state.byteLength},
          sha256 = ${stateSha256},
          updated_at = now()
        where id = ${versionRow.document_id}
          and org_id = ${input.orgId}
          and metadata->>'app' = 'docs'
      `;
      await appendDocsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "docs.version.restored",
        documentId: versionRow.document_id,
        payload: {
          restoredVersionId: input.versionId,
          restoredSeq: versionRow.seq,
          restoreVersionId: restoreRows[0]?.id ?? null,
        },
      });
      await this.persistDocumentState({
        orgId: input.orgId,
        documentId: versionRow.document_id,
        storageKey,
        state: reconstruction.state,
        sha256: stateSha256,
      });
      return {
        document: restoredDocument,
        restoredVersion: mapUpdate(versionRow),
        restoreVersion: mapUpdate(restoreRows[0]),
      };
    });
  }

  async compactDocument(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly state: Buffer;
    readonly stateVector?: Buffer | null | undefined;
  }): Promise<DocsDocumentRecord | null> {
    return this.sql.begin(async (tx) => {
      const stateSha256 = sha256Hex(input.state);
      const storageKey = docsDocumentStorageKey(input.orgId, input.documentId);
      const rows = (await tx`
        update docs_documents
        set
          ydoc_state = ${input.state},
          ydoc_state_vector = ${input.stateVector ?? null},
          updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const document = rows[0] === undefined ? null : mapDocument(rows[0]);
      if (document === null) {
        return null;
      }
      await tx`
        update objects
        set
          storage_key = ${storageKey},
          mime_type = ${docsDocumentMimeType},
          byte_size = ${input.state.byteLength},
          sha256 = ${stateSha256},
          updated_at = now()
        where id = ${input.documentId}
          and org_id = ${input.orgId}
          and metadata->>'app' = 'docs'
      `;
      await this.persistDocumentState({
        orgId: input.orgId,
        documentId: input.documentId,
        storageKey,
        state: input.state,
        sha256: stateSha256,
      });
      return document;
    });
  }

  private async persistDocumentState(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly storageKey: string;
    readonly state: Buffer;
    readonly sha256: string;
  }): Promise<void> {
    const storage = (await this.options.storageResolver?.({ orgId: input.orgId }))?.client;
    await storage?.put({
      key: input.storageKey,
      body: input.state,
      contentType: docsDocumentMimeType,
      metadata: {
        documentId: input.documentId,
        orgId: input.orgId,
        sha256: input.sha256,
      },
    });
  }

  private async persistAcceptedSuggestionState(
    sql: SqlLike,
    input: AppliedSuggestionDocumentState,
  ): Promise<void> {
    const storageKey = docsDocumentStorageKey(input.orgId, input.documentId);
    const stateSha256 = sha256Hex(input.state);
    await sql`
      update objects
      set
        storage_key = ${storageKey},
        mime_type = ${docsDocumentMimeType},
        byte_size = ${input.state.byteLength},
        sha256 = ${stateSha256},
        updated_at = now()
      where id = ${input.documentId}
        and org_id = ${input.orgId}
        and metadata->>'app' = 'docs'
    `;
    await this.persistDocumentState({
      orgId: input.orgId,
      documentId: input.documentId,
      storageKey,
      state: input.state,
      sha256: stateSha256,
    });
  }
}

function docsDocumentStorageKey(orgId: string, documentId: string): string {
  return `docs/${orgId}/${documentId}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stateSnapshotFromMetadata(metadata: JsonObject): Buffer | null {
  const stateBase64 = metadata.stateBase64;
  if (typeof stateBase64 !== "string" || stateBase64.length === 0) {
    return null;
  }
  try {
    return Buffer.from(stateBase64, "base64");
  } catch {
    return null;
  }
}

function lineDiff(before: string, after: string): readonly DocsVersionDiffLine[] {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const matrix = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );
  for (let oldIndex = beforeLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = afterLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const row = matrix[oldIndex];
      if (row === undefined) {
        continue;
      }
      row[newIndex] =
        beforeLines[oldIndex] === afterLines[newIndex]
          ? (matrix[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
          : Math.max(matrix[oldIndex + 1]?.[newIndex] ?? 0, matrix[oldIndex]?.[newIndex + 1] ?? 0);
    }
  }

  const diff: DocsVersionDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (
      oldIndex < beforeLines.length &&
      newIndex < afterLines.length &&
      beforeLines[oldIndex] === afterLines[newIndex]
    ) {
      diff.push({ kind: "unchanged", text: beforeLines[oldIndex] ?? "" });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (
      newIndex >= afterLines.length ||
      (oldIndex < beforeLines.length &&
        (matrix[oldIndex + 1]?.[newIndex] ?? 0) >= (matrix[oldIndex]?.[newIndex + 1] ?? 0))
    ) {
      diff.push({ kind: "removed", text: beforeLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      diff.push({ kind: "added", text: afterLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  return diff;
}

function splitDiffLines(value: string): readonly string[] {
  return value.length === 0 ? [] : value.replace(/\r\n/g, "\n").split("\n");
}

async function selectDocumentForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  documentId: string,
): Promise<DocsDocumentRecord | null> {
  const rows = (await sql`
    select *
    from docs_documents
    where id = ${documentId}
      and org_id = ${orgId}
      and deleted_at is null
      and (
        owner_actor_id = ${actorId}
        or created_by_actor_id = ${actorId}
        or exists (
          select 1 from permissions p
          where p.resource_type = 'document'
            and p.resource_id = docs_documents.id
            and p.org_id = ${orgId}
            and p.actor_id = ${actorId}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
    limit 1
  `) as unknown as readonly DocsDocumentRow[];
  return rows[0] === undefined ? null : mapDocument(rows[0]);
}

async function requireDocumentAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  documentId: string,
): Promise<void> {
  const document = await selectDocumentForActor(sql, orgId, actorId, documentId);
  if (document === null) {
    throw new Error(`Unknown or inaccessible document: ${documentId}`);
  }
}

async function requireCommentParent(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly parentCommentId: string;
  },
): Promise<void> {
  const rows = (await sql`
    select id
    from docs_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and document_id = ${input.documentId}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown parent comment: ${input.parentCommentId}`);
  }
}

async function requireDocumentExists(
  sql: SqlLike,
  orgId: string,
  documentId: string,
): Promise<void> {
  const rows = (await sql`
    select id
    from docs_documents
    where id = ${documentId}
      and org_id = ${orgId}
      and deleted_at is null
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown document: ${documentId}`);
  }
}

async function grantDocumentAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly actorId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'document', ${input.documentId}, ${input.role}, ${input.grantedByActorId})
    on conflict do nothing
  `;
}

async function grantThreadAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly threadId: string;
    readonly actorId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'thread', ${input.threadId}, ${input.role}, ${input.grantedByActorId})
    on conflict do nothing
  `;
}

async function appendDocsActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly documentId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash
    from activity
    where org_id = ${input.orgId}
    order by created_at desc
    limit 1
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const thisHash = `${prevHash ?? "root"}:${input.verb}:${input.documentId}:${String(Date.now())}`;
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (
      ${input.orgId},
      ${input.actorId},
      ${input.verb},
      'document',
      ${input.documentId},
      ${sql.json(toSqlJson(input.payload))},
      ${prevHash},
      ${thisHash}
    )
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        documentId: input.documentId,
        docId: input.documentId,
        ...input.payload,
      }),
    )})
  `;
}

async function notifyCommentMentions(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly body: string;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  const tokens = mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = (await sql`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and (
        id in (
          select owner_actor_id from docs_documents
          where id = ${input.documentId}
            and org_id = ${input.orgId}
            and owner_actor_id is not null
        )
        or id in (
          select created_by_actor_id from docs_documents
          where id = ${input.documentId}
            and org_id = ${input.orgId}
            and created_by_actor_id is not null
        )
        or exists (
          select 1 from permissions p
          where p.org_id = ${input.orgId}
            and p.actor_id = actors.id
            and p.resource_type = 'document'
            and p.resource_id = ${input.documentId}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
  `) as unknown as readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  const recipients = mentionedActorIds({
    actors: actorRows,
    authorActorId: input.actorId,
    tokens,
  });
  if (recipients.length === 0) {
    return;
  }
  const titleRows = (await sql`
    select title
    from docs_documents
    where id = ${input.documentId}
      and org_id = ${input.orgId}
    limit 1
  `) as unknown as readonly { readonly title: string }[];
  const authorName =
    actorRows.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  const title = titleRows[0]?.title ?? "a document";
  for (const recipientId of recipients) {
    await insertNotification(sql, {
      orgId: input.orgId,
      actorId: recipientId,
      verb: "docs.comment.mention",
      objectType: "document",
      objectId: input.documentId,
      summary: `${authorName} mentioned you in "${title}".`,
      body: input.body,
      payload: {
        documentId: input.documentId,
        docId: input.documentId,
        commentId: input.commentId,
        ...(input.parentCommentId === null ? {} : { parentCommentId: input.parentCommentId }),
        mentionedByActorId: input.actorId,
        mentionsText: tokens,
      },
    });
  }
}

function mentionTokensForComment(metadata: JsonObject, body: string): readonly string[] {
  const tokens = new Set<string>();
  for (const token of mentionTokensFromMetadata(metadata)) {
    tokens.add(token);
  }
  for (const token of mentionTokensFromText(body)) {
    tokens.add(token);
  }
  return [...tokens];
}

function mentionTokensFromMetadata(metadata: JsonObject): readonly string[] {
  const mentionsText = metadata.mentionsText;
  if (!Array.isArray(mentionsText)) {
    return [];
  }
  const tokens = new Set<string>();
  for (const value of mentionsText) {
    if (typeof value !== "string") {
      continue;
    }
    const token = normalizeMentionToken(value);
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionTokensFromText(value: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const token = normalizeMentionToken(match[2] ?? "");
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionedActorIds(input: {
  readonly actors: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  readonly authorActorId: string;
  readonly tokens: readonly string[];
}): readonly string[] {
  const tokenSet = new Set(input.tokens.map(normalizeMentionToken));
  const ids: string[] = [];
  for (const actor of input.actors) {
    if (actor.id === input.authorActorId) {
      continue;
    }
    const aliases = actorMentionAliases(actor);
    if ([...tokenSet].some((token) => aliases.has(token))) {
      ids.push(actor.id);
    }
  }
  return ids;
}

function actorMentionAliases(actor: {
  readonly display_name: string;
  readonly email: string | null;
}): ReadonlySet<string> {
  const aliases = new Set<string>();
  const email = actor.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0) {
    aliases.add(email);
    aliases.add(email.split("@")[0] ?? email);
  }
  const displayName = actor.display_name.trim().toLowerCase();
  if (displayName.length > 0) {
    aliases.add(displayName);
    aliases.add(displayName.replace(/[^a-z0-9]+/gu, ""));
    const firstName = displayName.split(/\s+/u)[0];
    if (firstName !== undefined) {
      aliases.add(firstName);
    }
  }
  return aliases;
}

function normalizeMentionToken(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

function mapDocument(row: DocsDocumentRow | undefined): DocsDocumentRecord {
  if (row === undefined) {
    throw new Error("Expected docs document row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    threadId: row.thread_id,
    ownerActorId: row.owner_actor_id,
    createdByActorId: row.created_by_actor_id,
    ydocState: row.ydoc_state,
    ydocStateVector: row.ydoc_state_vector,
    updateSeq: row.update_seq,
    editorEngine: row.editor_engine,
    formatVersion: row.format_version,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUpdate(row: DocsUpdateRow | undefined): DocsUpdateRecord {
  if (row === undefined) {
    throw new Error("Expected docs update row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    documentId: row.document_id,
    actorId: row.actor_id,
    seq: row.seq,
    update: row.update,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

interface AppliedSuggestionDocumentState {
  readonly orgId: string;
  readonly documentId: string;
  readonly state: Buffer;
}

async function applySuggestionToDocument(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly beforeText: string;
    readonly afterText: string;
    readonly anchorSelection?: NativeDocumentTextSelection | undefined;
  },
): Promise<AppliedSuggestionDocumentState | null> {
  if (input.beforeText.length === 0 || input.beforeText === input.afterText) {
    return null;
  }
  const documentRows = (await sql`
    select ydoc_state
    from docs_documents
    where id = ${input.documentId}
      and org_id = ${input.orgId}
      and deleted_at is null
    for update
  `) as unknown as readonly { readonly ydoc_state: Buffer | null }[];
  const stored = documentRows[0]?.ydoc_state ?? null;

  const replacement = replaceFirstTextInStoredState({
    state: stored,
    beforeText: input.beforeText,
    afterText: input.afterText,
    anchorSelection: input.anchorSelection,
  });
  if (replacement === null) {
    throw new Error("Suggestion no longer matches the document text.");
  }

  const seqRows = (await sql`
    update docs_documents
    set
      update_seq = update_seq + 1,
      ydoc_state = ${replacement.state},
      ydoc_state_vector = ${replacement.stateVector},
      updated_at = now()
    where id = ${input.documentId}
      and org_id = ${input.orgId}
      and deleted_at is null
    returning update_seq
  `) as unknown as readonly { readonly update_seq: number }[];
  const seq = seqRows[0]?.update_seq;
  if (seq === undefined) {
    throw new Error(`Unknown document: ${input.documentId}`);
  }
  await sql`
    insert into docs_updates (org_id, document_id, actor_id, seq, update, metadata)
    values (
      ${input.orgId},
      ${input.documentId},
      ${input.actorId},
      ${seq},
      ${replacement.update},
      ${sql.json(
        toSqlJson({
          source: "docs.suggestion.accept",
          stateBase64: replacement.state.toString("base64"),
        }),
      )}
    )
  `;
  return {
    orgId: input.orgId,
    documentId: input.documentId,
    state: replacement.state,
  };
}

function nativeDocumentSuggestionAnchorSelection(
  anchor: JsonObject,
): NativeDocumentTextSelection | undefined {
  if (anchor.kind !== "native-document" || anchor.target !== "selection") {
    return undefined;
  }
  const selection = anchor.selection;
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    return undefined;
  }
  const rawSelection = selection as Record<string, unknown>;
  const { from, to, text } = rawSelection;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    typeof text !== "string" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    text.trim().length === 0
  ) {
    return undefined;
  }
  return { from, to, text };
}

function mapSuggestion(row: DocsSuggestionRow | undefined): DocsSuggestionRecord {
  if (row === undefined) {
    throw new Error("Expected docs suggestion row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    documentId: row.document_id,
    actorId: row.actor_id,
    anchor: row.anchor,
    beforeText: row.before_text,
    afterText: row.after_text,
    reason: row.reason,
    status: normalizeSuggestionStatus(row.status),
    metadata: row.metadata,
    resolvedByActorId: row.resolved_by_actor_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSuggestionStatus(value: string): DocsSuggestionStatus {
  return value === "accepted" || value === "rejected" ? value : "pending";
}

function mapAskHistory(row: DocsAskHistoryRow | undefined): DocsAskHistoryRecord {
  if (row === undefined) {
    throw new Error("Expected docs ask history row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    documentId: row.document_id,
    actorId: row.actor_id,
    question: row.question,
    answer: row.answer,
    sourceScope: row.source_scope === "selection" ? "selection" : "document",
    sourceExcerpt: row.source_excerpt,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapComment(row: DocsCommentRow | undefined): DocsCommentRecord {
  if (row === undefined) {
    throw new Error("Expected docs comment row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    documentId: row.document_id,
    parentCommentId: row.parent_comment_id,
    actorId: row.actor_id,
    anchor: row.anchor,
    body: row.body,
    status: row.status,
    metadata: row.metadata,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommentListItem(row: DocsCommentProjectionRow): DocsCommentListItem {
  return {
    ...mapComment(row),
    ...(row.actor_id === null
      ? {}
      : {
          author: {
            id: row.actor_id,
            ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
            ...(row.actor_email === null ? {} : { email: row.actor_email }),
          },
        }),
  };
}

function mapCommentProjection(row: DocsCommentProjectionRow): DocsCommentProjection {
  return {
    id: row.id,
    parentCommentId: row.parent_comment_id,
    body: row.body,
    anchor: row.anchor,
    ...(row.actor_id === null
      ? {}
      : {
          author: {
            id: row.actor_id,
            ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
            ...(row.actor_email === null ? {} : { email: row.actor_email }),
          },
        }),
    createdAt: row.created_at.toISOString(),
  };
}

function mapDocsSearchRecord(
  row: DocsSearchProjectionRow,
  comments: readonly DocsCommentProjectionRow[],
  collaborators: readonly DocsActorRow[],
): DocsSearchRecord {
  const metadata = row.metadata;
  const markdown = documentTextFromStoredState(row.ydoc_state);
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    markdown,
    plainText: stringMetadata(metadata, "plainText") ?? markdown,
    ...metadataStringProperty(metadata, "html"),
    ...metadataOutlineProperty(metadata),
    comments: comments.map(mapCommentProjection),
    updatedAt: row.updated_at,
    metadata,
    ...(row.owner_actor_id === null
      ? {}
      : {
          owner: {
            id: row.owner_actor_id,
            ...(row.owner_display_name === null ? {} : { displayName: row.owner_display_name }),
            ...(row.owner_email === null ? {} : { email: row.owner_email }),
          },
        }),
    collaborators: collaborators.map(mapDocsActor),
    ...metadataStringArrayProperty(metadata, "tags"),
    ...metadataClassificationProperty(metadata),
    createdAt: row.created_at,
    ...(row.deleted_at === null ? {} : { archivedAt: row.deleted_at, deletedAt: row.deleted_at }),
  };
}

function mapDocsActor(row: DocsActorRow): NonNullable<DocsSearchRecord["owner"]> {
  return {
    id: row.id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.email === null ? {} : { email: row.email }),
  };
}

function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataStringProperty(metadata: JsonObject, key: string): Record<string, string> {
  const value = metadata[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function metadataStringArrayProperty(
  metadata: JsonObject,
  key: string,
): Pick<DocsSearchRecord, "tags"> {
  const value = metadata[key];
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? { tags: value }
    : {};
}

function metadataClassificationProperty(
  metadata: JsonObject,
): Pick<DocsSearchRecord, "classification"> {
  const value = metadata.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? { classification: value }
    : {};
}

function metadataOutlineProperty(metadata: JsonObject): Pick<DocsSearchRecord, "outline"> {
  const value = metadata.outline;
  if (!Array.isArray(value)) {
    return {};
  }
  const entries: readonly unknown[] = value;
  const outline = entries.filter(
    (
      item,
    ): item is {
      readonly id: string;
      readonly level: number;
      readonly title: string;
      readonly anchor: string;
      readonly summary?: string;
    } => {
      if (!isJsonRecord(item)) {
        return false;
      }
      return (
        typeof item.id === "string" &&
        typeof item.level === "number" &&
        typeof item.title === "string" &&
        typeof item.anchor === "string" &&
        (item.summary === undefined || typeof item.summary === "string")
      );
    },
  );
  return outline.length === 0 ? {} : { outline };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
