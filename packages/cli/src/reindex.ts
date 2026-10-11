import { buildHelixRequest } from "./client.js";
import { CliUsageError } from "./cli-error.js";
import { EXIT_CODES, sendForText } from "./http.js";
import type { HelixCommand } from "./parser.js";
import type { CliContext } from "./runner.js";

const reindexUsage =
  "Usage: helix reindex --all [--max-wait <seconds>] | helix reindex --status <job-id>";
/** How long `helix reindex --all` follows the job before handing back its id. */
const DEFAULT_MAX_WAIT_SECONDS = 30 * 60;
const POLL_INTERVAL_MS = 2_000;
const FINISHED = new Set(["completed", "cancelled", "dead_lettered"]);

export function parseReindexCommand(args: readonly string[]): HelixCommand {
  if (args.length === 2 && args[0] === "--status" && args[1] !== undefined) {
    if (args[1].startsWith("-")) throw new CliUsageError(reindexUsage);
    return { kind: "reindex-status", jobId: args[1] };
  }
  const rest = args.filter((arg) => arg !== "--all");
  if (args.length - rest.length !== 1) throw new CliUsageError(reindexUsage);
  if (rest.length === 0) return { kind: "reindex-all" };
  const seconds = Number(rest[1]);
  if (
    rest.length !== 2 ||
    rest[0] !== "--max-wait" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1
  )
    throw new CliUsageError(reindexUsage);
  return { kind: "reindex-all", maxWaitSeconds: seconds };
}

interface ReindexJob {
  readonly id: string;
  readonly status: string;
  readonly totalDocuments: string;
  readonly deletedDocuments?: string;
  readonly counts?: Readonly<Record<string, number>>;
  readonly lastError?: string;
}

function parseJob(text: string): ReindexJob {
  const value = JSON.parse(text) as Partial<ReindexJob> | null;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.totalDocuments !== "string"
  ) {
    throw new Error("Helix returned an unexpected search reindex job.");
  }
  return value as ReindexJob;
}

function describeProgress(job: ReindexJob): string {
  const counts = Object.entries(job.counts ?? {})
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count.toLocaleString("en-US")}`);
  const indexed = `${Number(job.totalDocuments).toLocaleString("en-US")} documents indexed`;
  return `Search reindex ${job.id}: ${job.status.replace("_", " ")}, ${indexed}${counts.length === 0 ? "" : ` (${counts.join(", ")})`}`;
}

/**
 * `helix reindex --all`: queues the reindex job, then follows it, printing
 * progress to stderr, until it finishes or `--max-wait` runs out. The job keeps
 * running on the server either way; `helix reindex --status <id>` checks it.
 */
export async function runReindexAll(
  command: Extract<HelixCommand, { kind: "reindex-all" }>,
  context: CliContext,
): Promise<number> {
  const text = context.options.output === "text";
  const report = (line: string) => {
    if (text) context.io.stderr.write(`${line}\n`);
  };
  const queued = await sendForText(buildHelixRequest(command, context.env), context, false);
  let job = parseJob(queued.body);
  report(`${describeProgress(job)}. Following it; Ctrl-C stops watching, not the job.`);
  const maxWaitMs = (command.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS) * 1000;
  let waitedMs = 0;
  let last = `${job.status}:${job.totalDocuments}`;
  while (!FINISHED.has(job.status)) {
    if (waitedMs >= maxWaitMs) {
      context.io.stderr.write(
        `Search reindex ${job.id} is still ${job.status} after ${String(maxWaitMs / 1000)}s. It keeps running; check it with: helix reindex --status ${job.id}\n`,
      );
      return EXIT_CODES.network;
    }
    await context.http.policy.sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
    const status = await sendForText(
      buildHelixRequest({ kind: "reindex-status", jobId: job.id }, context.env),
      context,
      true,
    );
    job = parseJob(status.body);
    const now = `${job.status}:${job.totalDocuments}`;
    if (now !== last) report(describeProgress(job));
    last = now;
  }
  context.io.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
  if (job.status === "completed") return 0;
  context.io.stderr.write(
    job.status === "cancelled"
      ? `Search reindex ${job.id} was cancelled.\n`
      : `Search reindex ${job.id} failed: ${(job.lastError ?? "no error was recorded").replace(/\.$/u, "")}. Run helix reindex --all to try again.\n`,
  );
  return EXIT_CODES.generic;
}
