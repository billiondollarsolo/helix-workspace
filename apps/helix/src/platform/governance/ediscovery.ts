import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { canonicalJson } from "../audit/hash.js";
import type { TenantStorageResolver } from "../storage/index.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

const governanceProducts = [
  "all",
  "mail",
  "chat",
  "drive",
  "calendar",
  "comment",
  "recording",
] as const;
export type GovernanceProduct = (typeof governanceProducts)[number];
const contentGovernanceProducts = [
  "mail",
  "chat",
  "drive",
  "calendar",
  "comment",
  "recording",
] as const;

interface GovernanceMatterRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "open" | "closed";
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface GovernanceHoldRow {
  readonly id: string;
  readonly org_id: string;
  readonly matter_id: string;
  readonly product: GovernanceProduct;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly reason: string;
  readonly released_at: Date | null;
  readonly created_at: Date;
}

interface GovernanceSearchRow {
  readonly item_key: string;
  readonly product: Exclude<GovernanceProduct, "all">;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly revision: string;
  readonly occurred_at: Date;
  readonly custodians: string[];
  readonly snapshot: JsonObject;
  readonly storage_objects: readonly {
    readonly key: string;
    readonly sha256: string | null;
    readonly byteSize: number;
  }[];
  readonly item_sha256: string;
  readonly review_disposition: "responsive" | "nonresponsive" | "privileged" | null;
}

interface GovernanceExportRow {
  readonly id: string;
  readonly matter_id: string;
  readonly object_key: string;
  readonly content_sha256: string;
  readonly manifest: JsonObject;
  readonly manifest_sha256: string;
  readonly previous_manifest_sha256: string | null;
  readonly created_at: Date;
}

export interface GovernanceSearchInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly matterId: string;
  readonly query?: string | undefined;
  readonly products?: readonly Exclude<GovernanceProduct, "all">[] | undefined;
  readonly from?: Date | null | undefined;
  readonly to?: Date | null | undefined;
  readonly after?: string | null | undefined;
  readonly limit?: number | undefined;
}

export interface GovernanceSearchItem {
  readonly itemKey: string;
  readonly product: Exclude<GovernanceProduct, "all">;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly revision: string;
  readonly occurredAt: string;
  readonly custodians: readonly string[];
  readonly snapshot: JsonObject;
  readonly storageObjects: GovernanceSearchRow["storage_objects"];
  readonly itemSha256: string;
  readonly reviewDisposition: GovernanceSearchRow["review_disposition"];
}

export class PostgresGovernanceStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly storageResolver?: TenantStorageResolver,
  ) {}

  createMatter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly name: string;
    readonly description: string;
  }): Promise<GovernanceMatterRow> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<GovernanceMatterRow[]>`
        insert into governance_matters(org_id, name, description, created_by_actor_id)
        values (${input.orgId}, ${input.name}, ${input.description}, ${input.actorId}) returning *
      `;
      return required(rows[0], "Matter was not created.");
    });
  }

  addCustodian(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly matterId: string;
    readonly custodianActorId: string;
  }): Promise<void> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      await tx`
        insert into governance_matter_custodians(org_id, matter_id, actor_id, added_by_actor_id)
        values (${input.orgId}, ${input.matterId}, ${input.custodianActorId}, ${input.actorId})
        on conflict do nothing
      `;
    });
  }

  createHold(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly matterId: string;
    readonly product: GovernanceProduct;
    readonly resourceType?: string | null | undefined;
    readonly resourceId?: string | null | undefined;
    readonly reason: string;
  }): Promise<GovernanceHoldRow> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<GovernanceHoldRow[]>`
        insert into governance_legal_holds(
          org_id, matter_id, product, resource_type, resource_id, reason, created_by_actor_id
        ) values (
          ${input.orgId}, ${input.matterId}, ${input.product}, ${input.resourceType ?? null},
          ${input.resourceId ?? null}, ${input.reason}, ${input.actorId}
        ) returning *
      `;
      return required(rows[0], "Legal hold was not created.");
    });
  }

  releaseHold(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly holdId: string;
  }): Promise<GovernanceHoldRow | null> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<GovernanceHoldRow[]>`
        update governance_legal_holds set released_at = statement_timestamp(),
          released_by_actor_id = ${input.actorId}
        where org_id = ${input.orgId} and id = ${input.holdId} and released_at is null
        returning *
      `;
      return rows[0] ?? null;
    });
  }

  setRetentionPolicy(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly name: string;
    readonly product: GovernanceProduct;
    readonly custodianActorId?: string | null | undefined;
    readonly retentionDays: number;
    readonly enabled: boolean;
  }): Promise<void> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      await tx`
        insert into governance_retention_policies(
          org_id, name, product, custodian_actor_id, retention_days, enabled, created_by_actor_id
        ) values (
          ${input.orgId}, ${input.name}, ${input.product}, ${input.custodianActorId ?? null},
          ${input.retentionDays}, ${input.enabled}, ${input.actorId}
        ) on conflict (org_id, name, product, custodian_actor_id) do update set
          retention_days = excluded.retention_days, enabled = excluded.enabled,
          updated_at = statement_timestamp()
      `;
    });
  }

  search(input: GovernanceSearchInput): Promise<readonly GovernanceSearchItem[]> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<GovernanceSearchRow[]>`
        select * from helix_governance_search(
          ${input.orgId}, ${input.actorId}, ${input.matterId}, ${input.query ?? ""},
          ${tx.array([...(input.products ?? [])])}::text[], ${input.from ?? null}, ${input.to ?? null},
          ${input.after ?? null}, ${input.limit ?? 100}
        )
      `;
      return rows.map(mapSearchItem);
    });
  }

  review(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly matterId: string;
    readonly itemKey: string;
    readonly itemSha256: string;
    readonly disposition: "responsive" | "nonresponsive" | "privileged";
    readonly note: string;
  }): Promise<void> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      await tx`
        insert into governance_review_items(
          org_id, matter_id, item_key, item_sha256, disposition, note, reviewed_by_actor_id
        ) values (
          ${input.orgId}, ${input.matterId}, ${input.itemKey}, ${input.itemSha256},
          ${input.disposition}, ${input.note}, ${input.actorId}
        ) on conflict (org_id, matter_id, item_key) do update set
          item_sha256 = excluded.item_sha256, disposition = excluded.disposition,
          note = excluded.note, reviewed_by_actor_id = excluded.reviewed_by_actor_id,
          reviewed_at = statement_timestamp()
      `;
    });
  }

  async exportMatter(
    input: Omit<GovernanceSearchInput, "after" | "limit">,
  ): Promise<GovernanceExportRow> {
    const storage = await this.storageResolver?.({ orgId: input.orgId });
    if (storage === undefined) throw new Error("Tenant storage is required for eDiscovery export.");
    const exportId = randomUUID();
    const prefix = `governance/exports/${input.matterId}/${exportId}`;
    const items: GovernanceSearchItem[] = [];
    let after: string | null = null;
    do {
      const page = await this.search({ ...input, after, limit: 500 });
      items.push(...page);
      if (items.length > 10_000) throw new Error("eDiscovery export exceeds 10,000 items.");
      after = page.length === 500 ? (page.at(-1)?.itemKey ?? null) : null;
    } while (after !== null);

    const copies = await copyEvidenceObjects(storage.client, prefix, items);
    const query = searchQueryJson(input);
    const content = new TextEncoder().encode(
      canonicalJson({ version: 1, query, items: items.map(exportContentItem) }),
    );
    const contentSha256 = sha256(content);
    const objectKey = `${prefix}/evidence.json`;
    const manifestObjectKey = `${prefix}/manifest.json`;
    await storage.client.put({
      key: objectKey,
      body: content,
      contentType: "application/json",
      metadata: { sha256: contentSha256 },
    });
    const rows = await withTenantPostgresContext(
      this.sql,
      input,
      (tx) =>
        tx<GovernanceExportRow[]>`
        select * from helix_governance_record_export(
          ${input.orgId}, ${input.actorId}, ${exportId}, ${input.matterId}, ${tx.json(query)},
          ${tx.json(items.map(exportItemSummary))}, ${objectKey}, ${contentSha256},
          ${manifestObjectKey}, ${tx.json(copies)}
        )
      `,
    );
    const record = required(rows[0], "eDiscovery export was not recorded.");
    const manifestBytes = new TextEncoder().encode(canonicalJson(record.manifest));
    await storage.client.put({
      key: manifestObjectKey,
      body: manifestBytes,
      contentType: "application/json",
      metadata: { sha256: record.manifest_sha256 },
    });
    return record;
  }
}

const productSchema = z.enum(governanceProducts);
const contentProductSchema = z.enum(contentGovernanceProducts);
const uuidSchema = z.string().uuid();
const matterParams = z.object({ id: uuidSchema });

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  options: {
    readonly store: PostgresGovernanceStore;
    readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
    readonly auditSink: AdminConsoleAuditSink;
  },
): Promise<void> {
  const write = async (request: FastifyRequest, reply: Parameters<typeof sendForbidden>[0]) => {
    const actor = await options.actorFromRequest(request);
    return canWriteAdminConsole(actor, "admin.governance")
      ? actor
      : sendForbidden(reply, adminConsoleWriteScope);
  };
  const read = async (request: FastifyRequest, reply: Parameters<typeof sendForbidden>[0]) => {
    const actor = await options.actorFromRequest(request);
    return canReadAdminConsole(actor, "admin.governance")
      ? actor
      : sendForbidden(reply, adminConsoleReadScope);
  };

  app.post("/api/admin/governance/matters", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const body = z
      .object({
        name: z.string().trim().min(1).max(255),
        description: z.string().max(10_000).default(""),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send(invalidRequest("Invalid matter.", body.error.issues));
    const matter = await options.store.createMatter({
      ...body.data,
      orgId: actor.orgId,
      actorId: actor.id,
    });
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.matter.created", "governance_matter", matter.id),
    );
    return reply.code(201).send({ matter: mapMatter(matter) });
  });

  app.post("/api/admin/governance/matters/:id/custodians", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    const body = z.object({ actorId: uuidSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send(invalidRequest("Invalid custodian."));
    await options.store.addCustodian({
      orgId: actor.orgId,
      actorId: actor.id,
      matterId: params.data.id,
      custodianActorId: body.data.actorId,
    });
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.custodian.added", "governance_matter", params.data.id, {
        custodianActorId: body.data.actorId,
      }),
    );
    return reply.code(201).send({ status: "added" });
  });

  app.post("/api/admin/governance/matters/:id/holds", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    const body = z
      .object({
        product: productSchema.default("all"),
        resourceType: z.string().trim().min(1).max(100).nullable().default(null),
        resourceId: uuidSchema.nullable().default(null),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .refine((value) => (value.resourceType === null) === (value.resourceId === null))
      .safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send(invalidRequest("Invalid legal hold."));
    const hold = await options.store.createHold({
      orgId: actor.orgId,
      actorId: actor.id,
      matterId: params.data.id,
      product: body.data.product,
      resourceType: body.data.resourceType,
      resourceId: body.data.resourceId,
      reason: body.data.reason,
    });
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.hold.created", "governance_legal_hold", hold.id),
    );
    return reply.code(201).send({ hold: mapHold(hold) });
  });

  app.post("/api/admin/governance/holds/:id/release", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(invalidRequest("Invalid legal hold id."));
    const hold = await options.store.releaseHold({
      orgId: actor.orgId,
      actorId: actor.id,
      holdId: params.data.id,
    });
    if (hold === null)
      return reply.code(404).send({ error: "Active legal hold not found.", code: "not_found" });
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.hold.released", "governance_legal_hold", hold.id),
    );
    return { hold: mapHold(hold) };
  });

  app.put("/api/admin/governance/retention-policies", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const body = z
      .object({
        name: z.string().trim().min(1).max(255),
        product: productSchema.default("all"),
        custodianActorId: uuidSchema.nullable().default(null),
        retentionDays: z.number().int().min(1).max(36_500),
        enabled: z.boolean().default(true),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send(invalidRequest("Invalid retention policy.", body.error.issues));
    await options.store.setRetentionPolicy({ ...body.data, orgId: actor.orgId, actorId: actor.id });
    await auditAdminAction(
      options.auditSink,
      auditRecord(
        actor,
        "governance.retention_policy.set",
        "governance_retention_policy",
        undefined,
        { name: body.data.name, product: body.data.product },
      ),
    );
    return { status: "set" };
  });

  app.post("/api/admin/governance/matters/:id/search", async (request, reply) => {
    const actor = await read(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    const body = searchBody().safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send(invalidRequest("Invalid eDiscovery search."));
    const items = await options.store.search(searchInput(actor, params.data.id, body.data));
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.search.executed", "governance_matter", params.data.id, {
        products: body.data.products,
        resultCount: items.length,
      }),
    );
    return {
      items,
      nextCursor: items.length === body.data.limit ? (items.at(-1)?.itemKey ?? null) : null,
    };
  });

  app.post("/api/admin/governance/matters/:id/reviews", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    const body = z
      .object({
        itemKey: z.string().min(1).max(500),
        itemSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        disposition: z.enum(["responsive", "nonresponsive", "privileged"]),
        note: z.string().max(10_000).default(""),
      })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send(invalidRequest("Invalid review."));
    await options.store.review({
      ...body.data,
      orgId: actor.orgId,
      actorId: actor.id,
      matterId: params.data.id,
    });
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.item.reviewed", "governance_matter", params.data.id, {
        itemKey: body.data.itemKey,
        disposition: body.data.disposition,
      }),
    );
    return { status: "reviewed" };
  });

  app.post("/api/admin/governance/matters/:id/exports", async (request, reply) => {
    const actor = await write(request, reply);
    if (!("orgId" in actor)) return actor;
    const params = matterParams.safeParse(request.params);
    const body = searchBody().omit({ after: true, limit: true }).safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send(invalidRequest("Invalid eDiscovery export."));
    const exported = await options.store.exportMatter(
      searchInput(actor, params.data.id, { ...body.data, after: null, limit: 100 }),
    );
    await auditAdminAction(
      options.auditSink,
      auditRecord(actor, "governance.export.created", "governance_export", exported.id, {
        matterId: params.data.id,
        manifestSha256: exported.manifest_sha256,
      }),
    );
    return reply.code(201).send({ export: mapExport(exported) });
  });
}

function searchBody() {
  return z
    .object({
      query: z.string().max(1000).default(""),
      products: z.array(contentProductSchema).max(6).default([]),
      from: z.coerce.date().nullable().default(null),
      to: z.coerce.date().nullable().default(null),
      after: z.string().max(500).nullable().default(null),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict();
}

function searchInput(
  actor: Actor,
  matterId: string,
  input: z.output<ReturnType<typeof searchBody>>,
): GovernanceSearchInput {
  return {
    orgId: actor.orgId,
    actorId: actor.id,
    matterId,
    query: input.query,
    products: input.products,
    from: input.from,
    to: input.to,
    after: input.after,
    limit: input.limit,
  };
}

async function copyEvidenceObjects(
  storage: NonNullable<Awaited<ReturnType<TenantStorageResolver>>>["client"],
  prefix: string,
  items: readonly GovernanceSearchItem[],
): Promise<readonly JsonObject[]> {
  const sources = new Map<string, { readonly sha256: string | null; readonly byteSize: number }>();
  for (const item of items)
    for (const source of item.storageObjects) sources.set(source.key, source);
  const copies: JsonObject[] = [];
  for (const [sourceKey, source] of sources) {
    const objectKey = `${prefix}/source/${sha256(sourceKey)}`;
    const head = await storage.head?.(sourceKey);
    if (head === null) throw new Error(`Missing held evidence object: ${sourceKey}`);
    if (storage.copy !== undefined) await storage.copy(sourceKey, objectKey);
    else {
      const object = (await storage.getStream?.(sourceKey)) ?? (await storage.get(sourceKey));
      if (object === null) throw new Error(`Missing held evidence object: ${sourceKey}`);
      await storage.put({ ...object, key: objectKey });
    }
    copies.push({
      source_key: sourceKey,
      object_key: objectKey,
      sha256: source.sha256,
      byte_size: head?.byteSize ?? source.byteSize,
    });
  }
  return copies;
}

function searchQueryJson(input: Omit<GovernanceSearchInput, "after" | "limit">): JsonObject {
  return {
    query: input.query ?? "",
    products: [...(input.products ?? [])],
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
  };
}

function exportItemSummary(item: GovernanceSearchItem): JsonObject {
  return {
    itemKey: item.itemKey,
    itemSha256: item.itemSha256,
    product: item.product,
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    revision: item.revision,
    occurredAt: item.occurredAt,
    reviewDisposition: item.reviewDisposition,
  };
}

function exportContentItem(item: GovernanceSearchItem): JsonObject {
  return {
    ...exportItemSummary(item),
    custodians: [...item.custodians],
    snapshot: item.snapshot,
    storageObjects: item.storageObjects.map((object) => ({ ...object })),
  };
}

function mapSearchItem(row: GovernanceSearchRow): GovernanceSearchItem {
  return {
    itemKey: row.item_key,
    product: row.product,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    revision: row.revision,
    occurredAt: row.occurred_at.toISOString(),
    custodians: row.custodians,
    snapshot: row.snapshot,
    storageObjects: row.storage_objects,
    itemSha256: row.item_sha256,
    reviewDisposition: row.review_disposition,
  };
}

function mapMatter(row: GovernanceMatterRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapHold(row: GovernanceHoldRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    matterId: row.matter_id,
    product: row.product,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    reason: row.reason,
    releasedAt: row.released_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapExport(row: GovernanceExportRow) {
  return {
    id: row.id,
    matterId: row.matter_id,
    objectKey: row.object_key,
    contentSha256: row.content_sha256,
    manifest: row.manifest,
    manifestSha256: row.manifest_sha256,
    previousManifestSha256: row.previous_manifest_sha256,
    createdAt: row.created_at.toISOString(),
  };
}

function auditRecord(
  actor: Actor,
  verb: string,
  objectType: string,
  objectId?: string,
  metadata?: Record<string, unknown>,
) {
  return {
    orgId: actor.orgId,
    actorId: actor.id,
    verb,
    objectType,
    ...(objectId === undefined ? {} : { objectId }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type { GovernanceExportRow, GovernanceHoldRow, GovernanceMatterRow };
