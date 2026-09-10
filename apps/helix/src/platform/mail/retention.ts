import type postgres from "postgres";

export interface MailTrashPurgeResult {
  readonly purgedMailboxes: number;
  readonly purgedThreads: number;
  readonly queuedObjects: number;
  readonly purgedJournalEntries: number;
}

export class PostgresMailTrashPurger {
  constructor(private readonly sql: postgres.Sql) {}

  async runBatch(limit = 100, dueBefore?: Date): Promise<MailTrashPurgeResult> {
    // Use the database clock by default; the journal rejects future cutoffs.
    const rows = await this.sql<
      {
        readonly purged_mailboxes: number;
        readonly purged_threads: number;
        readonly queued_objects: number;
      }[]
    >`select * from helix_purge_expired_mail_trash(
      ${Math.min(Math.max(Math.trunc(limit), 1), 500)},
      coalesce(${dueBefore ?? null}::timestamptz, statement_timestamp())
    )`;
    const journal = await this.sql<{ readonly purged: number }[]>`
      select helix_purge_expired_mail_journal(
        ${Math.min(Math.max(Math.trunc(limit), 1), 500)},
        coalesce(${dueBefore ?? null}::timestamptz, statement_timestamp())
      ) as purged
    `;
    const row = rows[0];
    return {
      purgedMailboxes: row?.purged_mailboxes ?? 0,
      purgedThreads: row?.purged_threads ?? 0,
      queuedObjects: row?.queued_objects ?? 0,
      purgedJournalEntries: journal[0]?.purged ?? 0,
    };
  }
}

export class MailTrashPurgeWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<MailTrashPurgeResult> | undefined;

  constructor(
    private readonly purger: Pick<PostgresMailTrashPurger, "runBatch">,
    private readonly intervalMs = 5 * 60 * 1000,
    private readonly onResult: (result: MailTrashPurgeResult) => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.runOnce();
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  runOnce(): Promise<MailTrashPurgeResult> {
    if (this.running !== undefined) return this.running;
    const running = this.purger
      .runBatch()
      .then((result) => {
        this.onResult(result);
        return result;
      })
      .catch((error: unknown) => {
        this.onError(error);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = running;
    return running;
  }
}
