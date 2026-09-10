import type { Actor } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import { errorMessage } from "../util/errors.js";
import { toSqlJson } from "../util/sql.js";
import type {
  SearchReindexCursor,
  SearchReindexRequest,
  SearchReindexSource,
  SearchReindexType,
} from "./reindex.js";
import { searchReindexTypes } from "./reindex.js";
import type { SearchEngine, SearchIndexMutation } from "./types.js";

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

export interface SearchReindexJob {
  readonly id: string;
  readonly orgId: string;
  readonly requestedByActorId: string;
  readonly targetOrgId?: string | undefined;
  readonly types: readonly SearchReindexType[];
  readonly batchSize: number;
  readonly shadowIndexUid: string;
  readonly status: SearchReindexJobStatus;
  readonly phase: "backfill" | "replay" | "swap";
  readonly sourceIndex: number;
  readonly sourceCursor?: SearchReindexCursor | undefined;
  readonly startMutationId: bigint;
  readonly replayMutationId: bigint;
  readonly totalDocuments: bigint;
  readonly attemptCount: number;
  readonly leaseToken?: string | undefined;
  readonly lastError?: string | undefined;
}

interface JobRow {
  readonly id: string;
  readonly org_id: string;
  readonly requested_by_actor_id: string;
  readonly target_org_id: string | null;
  readonly types: readonly SearchReindexType[];
  readonly batch_size: number;
  readonly shadow_index_uid: string;
  readonly status: SearchReindexJobStatus;
  readonly phase: SearchReindexJob["phase"];
  readonly source_index: number;
  readonly source_cursor: SearchReindexCursor | null;
  readonly start_mutation_id: string;
  readonly replay_mutation_id: string;
  readonly total_documents: string;
  readonly attempt_count: number;
  readonly lease_token: string | null;
  readonly last_error: string | null;
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
        ${this.sql.json(toSqlJson(input.mutation))},
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

  async createJob(actor: Actor, input: SearchReindexRequest = {}): Promise<SearchReindexJob> {
    const types = searchReindexTypes;
    const batchSize = normalizeBatchSize(input.batchSize);
    const id = randomUUID();
    const shadowIndexUid = `helix_search_shadow_${id.replaceAll("-", "")}`;
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
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly SearchReindexJob[]> {
    const rows = await this.sql<JobRow[]>`
      select * from helix_claim_search_reindex_jobs(
        ${input.owner}, ${input.limit}, ${input.leaseSeconds}
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
  get(id: string, orgId: string): Promise<SearchReindexJob | undefined>;
  cancel(id: string, orgId: string): Promise<boolean>;
}

export class PostgresSearchReindexJobService implements SearchReindexJobService {
  constructor(private readonly store: PostgresSearchDurabilityStore) {}
  create(actor: Actor, input?: SearchReindexRequest): Promise<SearchReindexJob> {
    return this.store.createJob(actor, input);
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

  constructor(
    private readonly options: {
      readonly store: PostgresSearchDurabilityStore;
      readonly engine: SearchEngine;
      readonly shadowEngine: (uid: string) => SearchEngine;
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
            await applyMutation(this.options.engine, item.mutation, item.orgId);
            for (const uid of await this.options.store.activeShadowIndexUids()) {
              await applyMutation(this.options.shadowEngine(uid), item.mutation, item.orgId);
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
    const engine = this.options.shadowEngine(job.shadowIndexUid);
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
        ...(job.targetOrgId === undefined ? {} : { orgId: job.targetOrgId }),
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
      for (const item of page.mutations) await applyMutation(engine, item.mutation);
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
        await this.options.swap(job.shadowIndexUid);
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

export async function applyMutation(
  engine: SearchEngine,
  mutation: SearchIndexMutation,
  orgId?: string,
): Promise<void> {
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
    ...(row.target_org_id === null ? {} : { targetOrgId: row.target_org_id }),
    types: row.types,
    batchSize: row.batch_size,
    shadowIndexUid: row.shadow_index_uid,
    status: row.status,
    phase: row.phase,
    sourceIndex: row.source_index,
    ...(row.source_cursor === null ? {} : { sourceCursor: row.source_cursor }),
    startMutationId: BigInt(row.start_mutation_id),
    replayMutationId: BigInt(row.replay_mutation_id),
    totalDocuments: BigInt(row.total_documents),
    attemptCount: row.attempt_count,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function normalizeBatchSize(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 1
    ? 100
    : Math.min(Math.floor(value), 1000);
}
