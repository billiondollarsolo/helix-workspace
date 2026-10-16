import type { Actor } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  detachedFromTenantPostgresContext,
  withTenantIoSagaPostgresContext,
} from "../tenancy/postgres-roles.js";
import { errorMessage } from "../util/errors.js";
import { toSqlJson } from "../util/sql.js";
import type {
  SearchReindexCursor,
  SearchReindexProgress,
  SearchReindexRequest,
  SearchReindexSource,
  SearchReindexType,
} from "./reindex.js";
import { searchReindexTypes } from "./reindex.js";
import type {
  SearchEngine,
  SearchIndexMutation,
  MailIndexReference,
  IndexDocument,
} from "./types.js";

export interface SearchMutationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly indexerId: string;
    readonly mutation: SearchIndexMutation;
    readonly occurredAt: string;
  }): Promise<void>;
}

interface MutationRow {
  readonly id: string;
  readonly org_id: string;
  readonly mutation: SearchIndexMutation;
  readonly attempt_count: number;
  readonly lease_token: string;
}

export interface ClaimedSearchMutation {
  readonly id: bigint;
  readonly orgId: string;
  readonly mutation: SearchIndexMutation;
  readonly attemptCount: number;
  readonly leaseToken: string;
}

type SearchReindexJobStatus = "queued" | "processing" | "completed" | "cancelled" | "dead_lettered";

/**
 * `shadow` rebuilds every organization into a new index and swaps it in;
 * `in_place` reindexes one organization (`targetOrgId`) into the live index.
 */
const searchShadowIndexPrefix = "helix_search_shadow_";

export type SearchReindexJobMode = "shadow" | "in_place";

export interface SearchReindexJob {
  readonly id: string;
  readonly orgId: string;
  readonly requestedByActorId: string;
  readonly mode: SearchReindexJobMode;
  readonly targetOrgId?: string | undefined;
  readonly types: readonly SearchReindexType[];
  readonly batchSize: number;
  /** The index a shadow job builds; null for in-place jobs. */
  readonly shadowIndexUid: string | null;
  readonly pruneStale: boolean;
  readonly status: SearchReindexJobStatus;
  readonly phase: "backfill" | "replay" | "swap";
  readonly sourceIndex: number;
  readonly sourceCursor?: SearchReindexCursor | undefined;
  readonly startMutationId: bigint;
  readonly replayMutationId: bigint;
  readonly totalDocuments: bigint;
  readonly deletedDocuments: bigint;
  /** Documents indexed so far, by type (in-place jobs). */
  readonly counts: Readonly<Partial<Record<SearchReindexType, number>>>;
  readonly attemptCount: number;
  readonly leaseToken?: string | undefined;
  readonly lastError?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date | undefined;
}

interface JobRow {
  readonly id: string;
  readonly org_id: string;
  readonly requested_by_actor_id: string;
  readonly mode: SearchReindexJobMode;
  readonly target_org_id: string | null;
  readonly types: readonly SearchReindexType[];
  readonly batch_size: number;
  readonly shadow_index_uid: string | null;
  readonly prune_stale: boolean;
  readonly status: SearchReindexJobStatus;
  readonly phase: SearchReindexJob["phase"];
  readonly source_index: number;
  readonly source_cursor: SearchReindexCursor | null;
  readonly start_mutation_id: string;
  readonly replay_mutation_id: string;
  readonly total_documents: string;
  readonly deleted_documents: string;
  readonly counts: Readonly<Partial<Record<SearchReindexType, number>>>;
  readonly attempt_count: number;
  readonly lease_token: string | null;
  readonly last_error: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
}

export class PostgresSearchDurabilityStore implements SearchMutationQueue {
  constructor(private readonly sql: postgres.Sql) {}

  async enqueue(input: {
    readonly orgId: string;
    readonly indexerId: string;
    readonly mutation: SearchIndexMutation;
    readonly occurredAt: string;
  }): Promise<void> {
    await this.sql`
      select helix_enqueue_search_index_mutation(
        ${input.orgId}, ${input.indexerId},
        ${this.sql.json(toSqlJson(compactMailMutation(input.mutation)))},
        ${input.occurredAt}
      )
    `;
  }

  async claimMutations(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly ClaimedSearchMutation[]> {
    const rows = await this.sql<MutationRow[]>`
      select * from helix_claim_search_index_mutations(
        ${input.owner}, ${input.limit}, ${input.leaseSeconds}
      )
    `;
    return rows.map((row) => ({
      id: BigInt(row.id),
      orgId: row.org_id,
      mutation: row.mutation,
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
    }));
  }

  async completeMutation(input: {
    readonly id: bigint;
    readonly leaseToken: string;
  }): Promise<void> {
    await this
      .sql`select helix_complete_search_index_mutation(${input.id.toString()}, ${input.leaseToken})`;
  }

  async failMutation(input: {
    readonly id: bigint;
    readonly leaseToken: string;
    readonly error: string;
    readonly retryDelaySeconds: number;
    readonly maxAttempts: number;
  }): Promise<void> {
    await this.sql`
      select helix_fail_search_index_mutation(
        ${input.id.toString()}, ${input.leaseToken}, ${input.error},
        ${input.retryDelaySeconds}, ${input.maxAttempts}
      )
    `;
  }

  async activeShadowIndexUids(): Promise<readonly string[]> {
    const rows = await this.sql<{ shadow_index_uid: string }[]>`
      select * from helix_active_search_shadow_indexes()
    `;
    return rows.map((row) => row.shadow_index_uid);
  }

  /**
   * Deletes the shadow indexes whose reindex job no longer exists (a job row
   * removed by a tenant reset or purge leaves its index behind). Needs a
   * connection that can see every job, such as the migration owner.
   */
  async deleteOrphanedShadowIndexes(engine: {
    listIndexUids(prefix: string): Promise<readonly string[]>;
    deleteIndex(uid: string): Promise<void>;
  }): Promise<number> {
    const uids = await engine.listIndexUids(searchShadowIndexPrefix);
    if (uids.length === 0) return 0;
    const known = await this.sql<{ shadow_index_uid: string }[]>`
      select shadow_index_uid from search_reindex_jobs where shadow_index_uid in ${this.sql(uids)}
    `;
    const kept = new Set(known.map((row) => row.shadow_index_uid));
    const orphans = uids.filter((uid) => !kept.has(uid));
    for (const uid of orphans) await engine.deleteIndex(uid);
    return orphans.length;
  }

  async createJob(actor: Actor, input: SearchReindexRequest = {}): Promise<SearchReindexJob> {
    const types = searchReindexTypes;
    const batchSize = normalizeBatchSize(input.batchSize);
    const id = randomUUID();
    const shadowIndexUid = `${searchShadowIndexPrefix}${id.replaceAll("-", "")}`;
    const rows = await this.sql<JobRow[]>`
      insert into search_reindex_jobs (
        id, org_id, requested_by_actor_id, target_org_id, types, batch_size,
        shadow_index_uid, start_mutation_id, replay_mutation_id, next_attempt_at
      ) values (
        ${id}, ${actor.orgId}, ${actor.id}, null, ${types}, ${batchSize},
        ${shadowIndexUid},
        (select last_mutation_id from search_index_checkpoints where consumer = 'live'),
        (select last_mutation_id from search_index_checkpoints where consumer = 'live'), now()
      ) returning *
    `;
    const job = rows[0];
    if (job === undefined) throw new Error("Search reindex job was not created.");
    return toJob(job);
  }

  /**
   * Queues an in-place reindex of the actor's organization, or returns the one
   * already queued or running there.
   */
  async createInPlaceJob(
    actor: Actor,
    input: SearchReindexRequest = {},
  ): Promise<SearchReindexJob> {
    const types =
      input.types === undefined || input.types.length === 0
        ? searchReindexTypes
        : searchReindexTypes.filter((type) => input.types?.includes(type));
    const created = await this.sql<JobRow[]>`
      insert into search_reindex_jobs (
        org_id, requested_by_actor_id, target_org_id, mode, types, batch_size, prune_stale,
        next_attempt_at
      ) values (
        ${actor.orgId}, ${actor.id}, ${actor.orgId}, 'in_place', ${types},
        ${normalizeBatchSize(input.batchSize)}, ${input.pruneStale !== false}, now()
      )
      on conflict (target_org_id) where mode = 'in_place' and status in ('queued', 'processing')
      do nothing
      returning *
    `;
    const rows =
      created.length > 0
        ? created
        : await this.sql<JobRow[]>`
            select * from search_reindex_jobs
            where org_id = ${actor.orgId} and target_org_id = ${actor.orgId}
              and mode = 'in_place' and status in ('queued', 'processing')
            limit 1
          `;
    const job = rows[0];
    if (job === undefined) throw new Error("Search reindex job was not created.");
    return toJob(job);
  }

  /**
   * Records progress and renews the lease. It commits on its own, outside the
   * tenant transaction the reindex runs in, so status reads see it at once.
   */
  async progressJob(
    job: SearchReindexJob,
    progress: SearchReindexProgress,
    leaseSeconds: number,
  ): Promise<boolean> {
    const rows = await detachedFromTenantPostgresContext(
      () => this.sql<{ saved: boolean }[]>`
        select helix_progress_search_reindex_job(
          ${job.id}, ${job.leaseToken ?? null}, ${progress.sourceIndex},
          ${progress.totalDocuments}, ${progress.deletedDocuments},
          ${this.sql.json(toSqlJson(progress.counts))}, ${leaseSeconds}
        ) saved
      `,
    );
    return rows[0]?.saved === true;
  }

  async getJob(id: string, orgId: string): Promise<SearchReindexJob | undefined> {
    const rows = await this.sql<JobRow[]>`
      select * from search_reindex_jobs where id = ${id} and org_id = ${orgId} limit 1
    `;
    return rows[0] === undefined ? undefined : toJob(rows[0]);
  }

  async cancelJob(id: string, orgId: string): Promise<boolean> {
    const rows = await this.sql<{ cancelled: boolean }[]>`
      select helix_cancel_search_reindex_job(${id}, ${orgId}) cancelled
    `;
    return rows[0]?.cancelled === true;
  }

  async claimJobs(input: {
    readonly owner: string;
    readonly mode: SearchReindexJobMode;
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly SearchReindexJob[]> {
    const rows = await this.sql<JobRow[]>`
      select * from helix_claim_search_reindex_jobs(
        ${input.owner}, ${input.mode}, ${input.limit}, ${input.leaseSeconds}
      )
    `;
    return rows.map(toJob);
  }

  async checkpointJob(input: {
    readonly job: SearchReindexJob;
    readonly phase: SearchReindexJob["phase"];
    readonly sourceIndex: number;
    readonly sourceCursor?: SearchReindexCursor | undefined;
    readonly replayMutationId: bigint;
    readonly documentCount: number;
  }): Promise<void> {
    await this.sql`
      select helix_checkpoint_search_reindex_job(
        ${input.job.id}, ${input.job.leaseToken ?? null}, ${input.phase}, ${input.sourceIndex},
        ${input.sourceCursor === undefined ? null : this.sql.json(toSqlJson(input.sourceCursor))},
        ${input.replayMutationId.toString()}, ${input.documentCount}
      )
    `;
  }

  async failJob(input: {
    readonly job: SearchReindexJob;
    readonly error: string;
    readonly retryDelaySeconds: number;
    readonly maxAttempts: number;
  }): Promise<void> {
    await this.sql`
      select helix_fail_search_reindex_job(
        ${input.job.id}, ${input.job.leaseToken ?? null}, ${input.error},
        ${input.retryDelaySeconds}, ${input.maxAttempts}
      )
    `;
  }

  async completeJob(job: SearchReindexJob): Promise<void> {
    await this.sql`
      select helix_complete_search_reindex_job(${job.id}, ${job.leaseToken ?? null})
    `;
  }

  async jobLeaseActive(job: SearchReindexJob): Promise<boolean> {
    const rows = await this.sql<{ active: boolean }[]>`
      select helix_search_reindex_lease_active(${job.id}, ${job.leaseToken ?? null}) active
    `;
    return rows[0]?.active === true;
  }

  async replayPage(
    after: bigint,
    limit: number,
  ): Promise<{
    readonly mutations: readonly { readonly id: bigint; readonly mutation: SearchIndexMutation }[];
    readonly liveCheckpoint: bigint;
  }> {
    const checkpoints = await this.sql<{ last_mutation_id: string }[]>`
      select last_mutation_id from search_index_checkpoints where consumer = 'live'
    `;
    const liveCheckpoint = BigInt(checkpoints[0]?.last_mutation_id ?? "0");
    const rows = await this.sql<{ id: string; mutation: SearchIndexMutation }[]>`
      select * from helix_search_replay_page(${after.toString()}, ${limit})
    `;
    return {
      liveCheckpoint,
      mutations: rows.map((row) => ({ id: BigInt(row.id), mutation: row.mutation })),
    };
  }

  withTenant<T>(orgId: string, callback: () => Promise<T>): Promise<T> {
    return withTenantIoSagaPostgresContext(this.sql, { orgId, serviceContext: true }, async () =>
      callback(),
    );
  }

  async withMutationSwapLock<T>(callback: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('helix-search-live-swap', 0))`;
      return callback();
    }) as Promise<T>;
  }
}

export interface SearchReindexJobService {
  create(actor: Actor, input?: SearchReindexRequest): Promise<SearchReindexJob>;
  createInPlace(actor: Actor, input?: SearchReindexRequest): Promise<SearchReindexJob>;
  get(id: string, orgId: string): Promise<SearchReindexJob | undefined>;
  cancel(id: string, orgId: string): Promise<boolean>;
}

export class PostgresSearchReindexJobService implements SearchReindexJobService {
  constructor(private readonly store: PostgresSearchDurabilityStore) {}
  create(actor: Actor, input?: SearchReindexRequest): Promise<SearchReindexJob> {
    return this.store.createJob(actor, input);
  }
  createInPlace(actor: Actor, input?: SearchReindexRequest): Promise<SearchReindexJob> {
    return this.store.createInPlaceJob(actor, input);
  }
  get(id: string, orgId: string): Promise<SearchReindexJob | undefined> {
    return this.store.getJob(id, orgId);
  }
  cancel(id: string, orgId: string): Promise<boolean> {
    return this.store.cancelJob(id, orgId);
  }
}

export class SearchMutationWorker {
  private readonly owner = `search-index-${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<number> | undefined;
  /** Shadow indexes this worker has created or confirmed. */
  private readonly readyShadowIndexes = new Set<string>();

  constructor(
    private readonly options: {
      readonly store: PostgresSearchDurabilityStore;
      readonly engine: SearchEngine;
      readonly loadMail?:
        ((reference: MailIndexReference) => Promise<IndexDocument | null>) | undefined;
      readonly shadowEngine: (uid: string) => SearchEngine & { ensureIndex(): Promise<void> };
      readonly intervalMs?: number | undefined;
      readonly maxAttempts?: number | undefined;
      readonly onError?: ((error: unknown) => void) | undefined;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs ?? 1_000);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const claimed = await this.options.store.claimMutations({
      owner: this.owner,
      limit: 25,
      leaseSeconds: 300,
    });
    for (const item of claimed) {
      try {
        await this.options.store.withTenant(item.orgId, async () => {
          await this.options.store.withMutationSwapLock(async () => {
            await applyMutation(
              this.options.engine,
              item.mutation,
              item.orgId,
              this.options.loadMail,
            );
            for (const uid of await this.options.store.activeShadowIndexUids()) {
              await applyMutation(
                await this.shadowIndex(uid),
                item.mutation,
                item.orgId,
                this.options.loadMail,
              );
            }
          });
        });
        await this.options.store.completeMutation(item);
      } catch (error) {
        await this.options.store.failMutation({
          ...item,
          error: errorMessage(error),
          retryDelaySeconds: Math.min(3600, 2 ** item.attemptCount),
          maxAttempts: this.options.maxAttempts ?? 8,
        });
        this.options.onError?.(error);
      }
    }
    return claimed.length;
  }

  /**
   * A shadow job is active from the moment it is queued (offboarding queues
   * one), but the shadow worker creates its index only when the backfill
   * starts. Mirrored mutations must not wait for that: a delete into a missing
   * index fails with index_not_found and would retry until the job runs.
   */
  private async shadowIndex(uid: string): Promise<SearchEngine> {
    const engine = this.options.shadowEngine(uid);
    if (!this.readyShadowIndexes.has(uid)) {
      await engine.ensureIndex();
      this.readyShadowIndexes.add(uid);
    }
    return engine;
  }

  private runScheduled(): Promise<number> {
    if (this.active !== undefined) return this.active;
    this.active = this.drainOnce()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}

export class SearchShadowReindexWorker {
  private readonly owner = `search-reindex-${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<number> | undefined;

  constructor(
    private readonly options: {
      readonly loadMail?:
        ((reference: MailIndexReference) => Promise<IndexDocument | null>) | undefined;
      readonly store: PostgresSearchDurabilityStore;
      readonly sources: readonly SearchReindexSource[];
      readonly shadowEngine: (uid: string) => SearchEngine & { ensureIndex(): Promise<void> };
      readonly swap: (shadowUid: string) => Promise<void>;
      readonly intervalMs?: number | undefined;
      readonly maxAttempts?: number | undefined;
      readonly onError?: ((error: unknown) => void) | undefined;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs ?? 1_000);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const jobs = await this.options.store.claimJobs({
      owner: this.owner,
      mode: "shadow",
      limit: 1,
      leaseSeconds: 300,
    });
    const job = jobs[0];
    if (job === undefined) return 0;
    try {
      await this.step(job);
    } catch (error) {
      await this.options.store.failJob({
        job,
        error: errorMessage(error),
        retryDelaySeconds: Math.min(3600, 2 ** job.attemptCount),
        maxAttempts: this.options.maxAttempts ?? 8,
      });
      this.options.onError?.(error);
    }
    return 1;
  }

  private async step(job: SearchReindexJob): Promise<void> {
    const shadowIndexUid = job.shadowIndexUid;
    if (shadowIndexUid === null) throw new Error("A shadow reindex job needs its shadow index.");
    const engine = this.options.shadowEngine(shadowIndexUid);
    if (job.phase === "backfill" && job.sourceIndex === 0 && job.sourceCursor === undefined) {
      await engine.ensureIndex();
    }
    if (job.phase === "backfill") {
      const type = job.types[job.sourceIndex];
      if (type === undefined) {
        await this.options.store.checkpointJob({
          job,
          phase: "replay",
          sourceIndex: job.sourceIndex,
          replayMutationId: job.replayMutationId,
          documentCount: 0,
        });
        return;
      }
      const source = this.options.sources.find((candidate) => candidate.type === type);
      if (source?.collectPage === undefined)
        throw new Error(`Search source ${type} is not resumable.`);
      const page = await source.collectPage({
        batchSize: job.batchSize,
        ...(job.sourceCursor === undefined ? {} : { cursor: job.sourceCursor }),
      });
      await engine.upsert(page.documents);
      await this.options.store.checkpointJob({
        job,
        phase: "backfill",
        sourceIndex: page.done ? job.sourceIndex + 1 : job.sourceIndex,
        ...(!page.done && page.cursor !== undefined ? { sourceCursor: page.cursor } : {}),
        replayMutationId: job.replayMutationId,
        documentCount: page.documents.length,
      });
      return;
    }
    if (job.phase === "replay") {
      const page = await this.options.store.replayPage(job.replayMutationId, job.batchSize);
      for (const item of page.mutations)
        await applyMutation(engine, item.mutation, undefined, this.options.loadMail);
      const last = page.mutations.at(-1)?.id ?? job.replayMutationId;
      await this.options.store.checkpointJob({
        job,
        phase:
          page.mutations.length < job.batchSize && last >= page.liveCheckpoint ? "swap" : "replay",
        sourceIndex: job.sourceIndex,
        replayMutationId: last,
        documentCount: 0,
      });
      return;
    }
    await this.options.store.withMutationSwapLock(async () => {
      if (await this.options.store.jobLeaseActive(job)) {
        await this.options.swap(shadowIndexUid);
        await this.options.store.completeJob(job);
      }
    });
  }

  private runScheduled(): Promise<number> {
    if (this.active !== undefined) return this.active;
    this.active = this.drainOnce()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}

/** Keep durable replay useful without retaining another full copy of each email. */
export function compactMailMutation(mutation: SearchIndexMutation): SearchIndexMutation {
  const reloadMail = [...(mutation.reloadMail ?? [])];
  const upsert = [];
  for (const document of mutation.upsert ?? []) {
    if (document.type !== "mail") {
      upsert.push(document);
      continue;
    }
    const { orgId, ragOwnerActorId: actorId, messageId } = document.attributes ?? {};
    if (
      typeof orgId !== "string" ||
      typeof actorId !== "string" ||
      typeof messageId !== "string" ||
      document.id !== `mail:${actorId}:${messageId}`
    )
      throw new Error("Mail search mutation has no valid source identity.");
    reloadMail.push({ orgId, actorId, messageId });
  }
  return {
    ...mutation,
    ...(mutation.upsert === undefined ? {} : { upsert }),
    ...(reloadMail.length === 0 ? {} : { reloadMail }),
  };
}

export async function applyMutation(
  engine: SearchEngine,
  mutation: SearchIndexMutation,
  orgId?: string,
  loadMail?: (reference: MailIndexReference) => Promise<IndexDocument | null>,
): Promise<void> {
  for (const reference of mutation.reloadMail ?? []) {
    if (loadMail === undefined || (orgId !== undefined && orgId !== reference.orgId))
      throw new Error("Mail search source resolution is unavailable or has a different tenant.");
    const document = await loadMail(reference);
    if (document === null)
      await engine.delete([`mail:${reference.actorId}:${reference.messageId}`], reference.orgId);
    else await engine.upsert([document]);
  }
  if (mutation.upsert !== undefined && mutation.upsert.length > 0)
    await engine.upsert(mutation.upsert);
  if (mutation.delete !== undefined && mutation.delete.length > 0) {
    await engine.delete(mutation.delete, mutation.orgId ?? orgId);
  }
}

function toJob(row: JobRow): SearchReindexJob {
  return {
    id: row.id,
    orgId: row.org_id,
    requestedByActorId: row.requested_by_actor_id,
    mode: row.mode,
    ...(row.target_org_id === null ? {} : { targetOrgId: row.target_org_id }),
    types: row.types,
    batchSize: row.batch_size,
    shadowIndexUid: row.shadow_index_uid,
    pruneStale: row.prune_stale,
    status: row.status,
    phase: row.phase,
    sourceIndex: row.source_index,
    ...(row.source_cursor === null ? {} : { sourceCursor: row.source_cursor }),
    startMutationId: BigInt(row.start_mutation_id),
    replayMutationId: BigInt(row.replay_mutation_id),
    totalDocuments: BigInt(row.total_documents),
    deletedDocuments: BigInt(row.deleted_documents),
    counts: row.counts,
    attemptCount: row.attempt_count,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function normalizeBatchSize(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 1
    ? 100
    : Math.min(Math.floor(value), 1000);
}
