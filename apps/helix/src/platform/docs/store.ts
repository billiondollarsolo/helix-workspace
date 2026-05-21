import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import * as Y from "yjs";
import { exportDocsDocument } from "./export/index.js";
import type {
  DocsCommentProjection,
  DocsCommentRecord,
  DocsDocumentRecord,
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
} from "./types.js";

export interface CreateDocsDocumentInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string;
  readonly initialMarkdown?: string | undefined;
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
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsCommentRecord>;
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
  resolveSuggestion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly suggestionId: string;
    readonly status: "accepted" | "rejected";
  }): Promise<DocsSuggestionRecord | null>;
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
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DocsUpdateRow {
  readonly id: string;
  readonly org_id: string;
  readonly document_id: string;
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

export class PostgresDocsStore
  implements DocsStore, DocsSearchProjectionStore, DocsOutlineEnrichmentStore
{
  constructor(private readonly sql: postgres.Sql) {}

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

      const initialState = Buffer.from(input.initialMarkdown ?? "", "utf8");
      const documentRows = (await tx`
        insert into docs_documents (
          org_id, title, thread_id, owner_actor_id, created_by_actor_id, ydoc_state, update_seq, metadata
        )
        values (
          ${input.orgId},
          ${input.title},
          ${threadId},
          ${input.actorId},
          ${input.actorId},
          ${initialState},
          0,
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DocsDocumentRow[];
      const document = mapDocument(documentRows[0]);
      const driveMetadata = toSqlJson({
        ...(input.metadata ?? {}),
        app: "docs",
        docId: document.id,
        name: `${input.title}.helixdoc`,
        title: input.title,
        folderId: input.folderId ?? null,
      });

      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${document.id},
          ${input.orgId},
          ${input.actorId},
          'file',
          ${`docs/${input.orgId}/${document.id}`},
          'application/vnd.helix.document',
          ${initialState.byteLength},
          null,
          ${tx.json(driveMetadata)}
        )
        on conflict (id) do update set
          metadata = excluded.metadata,
          updated_at = now()
      `;

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
        markdown: markdownFromStoredYDocState(document.ydocState),
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
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DocsCommentRecord> {
    return this.sql.begin(async (tx) => {
      await requireDocumentAccess(tx, input.orgId, input.actorId, input.documentId);
      const rows = (await tx`
        insert into docs_comments (org_id, document_id, actor_id, anchor, body, metadata)
        values (
          ${input.orgId},
          ${input.documentId},
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
      return mapComment(rows[0]);
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

      if (input.status === "accepted") {
        await applySuggestionToDocument(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          documentId: existing.document_id,
          beforeText: existing.before_text,
          afterText: existing.after_text,
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
      return rows[0] === undefined ? null : mapSuggestion(rows[0]);
    });
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
      markdown: markdownFromStoredYDocState(document.ydocState),
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

  async compactDocument(input: {
    readonly orgId: string;
    readonly documentId: string;
    readonly state: Buffer;
    readonly stateVector?: Buffer | null | undefined;
  }): Promise<DocsDocumentRecord | null> {
    const rows = (await this.sql`
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
    return rows[0] === undefined ? null : mapDocument(rows[0]);
  }
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

async function grantObjectAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly actorId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'object', ${input.objectId}, ${input.role}, ${input.grantedByActorId})
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

/**
 * Applies an accepted suggestion to a document by replacing the first occurrence of
 * `beforeText` with `afterText` in the document's Yjs `markdown` text. The edit is
 * persisted both as an incremental update and as a compacted document state so live
 * Yjs sync sessions and the stored snapshot stay consistent.
 */
async function applySuggestionToDocument(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly beforeText: string;
    readonly afterText: string;
  },
): Promise<void> {
  if (input.beforeText.length === 0 || input.beforeText === input.afterText) {
    return;
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

  const doc = new Y.Doc();
  if (stored !== null && stored.length > 0) {
    try {
      Y.applyUpdate(doc, new Uint8Array(stored));
    } catch {
      doc.getText("markdown").insert(0, stored.toString("utf8"));
    }
  }
  const markdown = doc.getText("markdown");
  const index = markdown.toJSON().indexOf(input.beforeText);
  if (index === -1) {
    doc.destroy();
    throw new Error("Suggestion no longer matches the document text.");
  }

  const beforeUpdate = Y.encodeStateVector(doc);
  doc.transact(() => {
    markdown.delete(index, input.beforeText.length);
    markdown.insert(index, input.afterText);
  }, "docs.suggestion.accept");
  const incremental = Y.encodeStateAsUpdate(doc, beforeUpdate);
  const compacted = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();

  const seqRows = (await sql`
    update docs_documents
    set
      update_seq = update_seq + 1,
      ydoc_state = ${Buffer.from(compacted)},
      ydoc_state_vector = ${Buffer.from(stateVector)},
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
      ${Buffer.from(incremental)},
      ${sql.json(toSqlJson({ source: "docs.suggestion.accept" }))}
    )
  `;
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

function mapComment(row: DocsCommentRow | undefined): DocsCommentRecord {
  if (row === undefined) {
    throw new Error("Expected docs comment row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    documentId: row.document_id,
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

function mapCommentProjection(row: DocsCommentProjectionRow): DocsCommentProjection {
  return {
    id: row.id,
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
  const markdown = markdownFromStoredYDocState(row.ydoc_state);
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

function markdownFromStoredYDocState(state: Buffer | null): string {
  if (state === null || state.length === 0) {
    return "";
  }
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(state));
    return doc.getText("markdown").toJSON();
  } catch {
    return state.toString("utf8");
  }
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
