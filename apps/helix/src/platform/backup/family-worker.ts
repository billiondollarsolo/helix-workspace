import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer } from "node:https";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  familyBackupPolicy,
  familyBackupReceipt,
  familyBackupRequest,
  familyBackupProtocol,
  type FamilyBackupJob,
  type FamilyBackupPolicy,
  type FamilyBackupRequest,
  type FamilyBackupStatus,
} from "./family-protocol.js";
import {
  keyHash,
  loadState,
  matchesKey,
  persist,
  protectedFile,
  privateStateDirectory,
  workerConfiguration,
  type WorkerConfiguration,
} from "./family-worker-state.js";

class UnknownRecoveryOutcome extends Error {}

class BackupWorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** One operator-owned executor; neither identity credentials nor remote command strings are accepted. */
export class FamilyBackupWorker {
  readonly state;
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private healthy: boolean | null = null;
  private healthCheckedAt = 0;
  constructor(
    readonly config: WorkerConfiguration,
    private readonly now = () => Date.now(),
  ) {
    const management = protectedFile(config.managementKeyFile).trim();
    if (!/^[a-f0-9]{64}$/u.test(management)) throw new Error("Invalid recovery management key");
    if (config.restoreKeyFile) {
      const restore = protectedFile(config.restoreKeyFile).trim();
      if (!/^[a-f0-9]{64}$/u.test(restore) || restore === management)
        throw new Error("Independent recovery restore key required");
    }
    if (config.scheduler === "worker" && !config.localSchedulerDisabled)
      throw new Error(
        "Explicitly retire the existing scheduler before this worker owns backup scheduling",
      );
    this.state = loadState(config);
    this.checkPolicy(this.state.policy);
  }
  private save() {
    persist(join(this.config.stateDirectory, "state.json"), this.state);
  }
  private checkPolicy(policy: FamilyBackupPolicy) {
    if (
      policy.retentionDays < this.config.minimumRetentionDays ||
      !this.config.destinations.includes(policy.destinationRef)
    )
      throw new BackupWorkerError(
        409,
        "Policy exceeds the operator-approved retention or destination boundary.",
      );
    if (policy.enabled && this.config.scheduler !== "worker")
      throw new BackupWorkerError(
        409,
        "An external scheduler owns this target; change its policy with its existing operator.",
      );
  }
  authenticate(request: IncomingMessage, mode: "read" | "manage" | "restore" = "manage") {
    const authorization = request.headers.authorization;
    const supplied =
      typeof authorization === "string"
        ? /^Bearer ([a-f0-9]{64})$/u.exec(authorization)?.[1]
        : undefined;
    const files =
      mode === "read"
        ? [this.config.managementKeyFile, this.config.restoreKeyFile]
        : [mode === "restore" ? this.config.restoreKeyFile : this.config.managementKeyFile];
    if (
      request.headers.cookie ||
      !supplied ||
      !files.some((file) => file && matchesKey(supplied, file)) ||
      (this.state.revokedKeys.includes(keyHash(supplied)) &&
        request.url !== "/v1/family-operations/detach")
    )
      throw new BackupWorkerError(401, "A separate recovery capability is required.");
    return supplied;
  }
  setPolicy(value: unknown) {
    const policy = familyBackupPolicy.parse(value);
    this.checkPolicy(policy);
    if (
      policy.revision < this.state.policy.revision ||
      (policy.revision === this.state.policy.revision &&
        JSON.stringify(policy) !== JSON.stringify(this.state.policy))
    )
      throw new BackupWorkerError(409, "Recovery policy is older than the accepted revision.");
    this.state.policy = policy;
    this.state.owner = "workspace";
    this.save();
    return policy;
  }
  detach(key: string) {
    if (!this.state.revokedKeys.includes(keyHash(key))) this.state.revokedKeys.push(keyHash(key));
    if (this.config.restoreKeyFile) {
      const restoreKey = protectedFile(this.config.restoreKeyFile).trim();
      if (!this.state.revokedKeys.includes(keyHash(restoreKey)))
        this.state.revokedKeys.push(keyHash(restoreKey));
    }
    this.state.owner = "local";
    this.save();
  }
  request(value: unknown, authorityExpiresAt: string | null = null): FamilyBackupJob {
    const request = familyBackupRequest.parse(value);
    const previous = this.state.jobs.find((job) => job.request.id === request.id);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request))
        throw new BackupWorkerError(409, "Operation ID was already used with different input.");
      if (previous.status === "queued" && previous.request.kind === "restore") {
        this.authority(authorityExpiresAt);
        previous.authorityExpiresAt = authorityExpiresAt;
        this.save();
      }
      return previous;
    }
    if (this.state.jobs.some((job) => job.status === "unknown"))
      throw new BackupWorkerError(
        409,
        "An interrupted recovery operation needs local operator reconciliation.",
      );
    if (this.state.jobs.length >= 10000)
      throw new BackupWorkerError(
        409,
        "Archive the worker receipt journal with its operator before admitting more jobs.",
      );
    if (!this.config.commands[request.kind])
      throw new BackupWorkerError(409, "This recovery capability is not configured.");
    if (
      request.kind === "restore" &&
      this.config.binding.application === "workspace" &&
      !request.targetObjectBucket
    )
      throw new BackupWorkerError(400, "Workspace restore requires a new object bucket.");
    if (request.kind !== "backup") {
      const source = this.source(request);
      if (!source || (request.kind === "restore" && !source.verifiedAt))
        throw new BackupWorkerError(
          409,
          "A completed, verified backup is required for isolated restore.",
        );
    }
    if (request.kind === "restore") this.authority(authorityExpiresAt);
    const job: FamilyBackupJob = {
      authorityExpiresAt,
      request,
      status: "queued",
      createdAt: new Date(this.now()).toISOString(),
      completedAt: null,
      error: null,
      receipt: null,
    };
    this.state.jobs.push(job);
    this.save();
    return job;
  }
  private authority(value: string | null) {
    if (
      !value ||
      !Number.isFinite(Date.parse(value)) ||
      Date.parse(value) <= this.now() ||
      Date.parse(value) > this.now() + 30000
    )
      throw new BackupWorkerError(403, "A current, bounded recovery approval is required.");
  }
  private source(request: FamilyBackupRequest) {
    return [...this.state.jobs]
      .reverse()
      .find((job) => job.status === "completed" && job.receipt?.backupId === request.backupId)
      ?.receipt;
  }
  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (this.config.healthUrl)
        try {
          this.healthy = (
            await fetch(this.config.healthUrl, {
              redirect: "error",
              signal: AbortSignal.timeout(3000),
            })
          ).ok;
        } catch {
          this.healthy = false;
        }
      if (this.config.healthUrl) this.healthCheckedAt = this.now();
      await this.tick();
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async tick() {
    if (this.state.jobs.some((job) => job.status === "unknown")) return;
    const policy = this.state.policy;
    if (policy.enabled && this.config.scheduler === "worker") {
      const interval = policy.intervalMinutes * 60000;
      const latest = [...this.state.jobs].reverse().find((job) => job.request.kind === "backup");
      if (!latest || this.now() - Date.parse(latest.createdAt) >= interval) {
        const hash = createHash("sha256")
          .update(
            `${JSON.stringify(this.config.binding)}:${String(policy.revision)}:${String(Math.floor(this.now() / interval))}`,
          )
          .digest("hex");
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        this.request({ id, kind: "backup" });
      }
    }
    const job = this.state.jobs.find((job) => job.status === "queued");
    if (!job) return;
    if (
      job.request.kind === "restore" &&
      (!job.authorityExpiresAt || Date.parse(job.authorityExpiresAt) <= this.now())
    ) {
      job.status = "failed";
      job.error = "source_unavailable";
      job.completedAt = new Date(this.now()).toISOString();
      this.save();
      return;
    }
    job.status = "running";
    this.save();
    const directory = join(this.config.stateDirectory, job.request.id);
    mkdirSync(directory, { mode: 0o700 });
    const receiptFile = join(directory, "receipt.json");
    const executionPolicy = { ...this.state.policy };
    persist(join(directory, "request.json"), {
      request: job.request,
      policy: executionPolicy,
      binding: this.config.binding,
      source: this.source(job.request) ?? null,
    });
    try {
      await this.execute(job, directory, receiptFile);
      const receipt = familyBackupReceipt.parse(JSON.parse(protectedFile(receiptFile)));
      const source = this.source(job.request);
      if (
        receipt.backupId !== (job.request.backupId ?? job.request.id) ||
        (job.request.kind === "backup" &&
          (receipt.destinationRef !== executionPolicy.destinationRef ||
            receipt.retentionDays < executionPolicy.retentionDays ||
            Date.parse(receipt.createdAt) < Date.parse(job.createdAt))) ||
        [receipt.createdAt, receipt.verifiedAt, receipt.restoredAt].some(
          (value) => value !== null && Date.parse(value) > this.now() + 10000,
        ) ||
        !this.config.requiredCoverage.every((value) => receipt.coverage.includes(value)) ||
        (source &&
          (source.artifactDigest !== receipt.artifactDigest ||
            source.manifestDigest !== receipt.manifestDigest)) ||
        (job.request.kind !== "backup" &&
          (!receipt.verifiedAt || Date.parse(receipt.verifiedAt) < Date.parse(job.createdAt))) ||
        (job.request.kind === "restore" &&
          (!receipt.restoredAt ||
            Date.parse(receipt.restoredAt) < Date.parse(job.createdAt) ||
            receipt.targetDatabase !== job.request.targetDatabase ||
            receipt.targetObjectBucket !== (job.request.targetObjectBucket ?? null)))
      )
        throw new BackupWorkerError(
          422,
          "Recovery receipt does not prove the requested operation.",
        );
      job.receipt = receipt;
      job.status = "completed";
      job.error = null;
    } catch (error) {
      if (error instanceof UnknownRecoveryOutcome) {
        job.status = "unknown";
        job.error = "interrupted";
      } else {
        job.status = "failed";
        job.error = error instanceof BackupWorkerError ? "invalid_receipt" : "execution_failed";
      }
    }
    job.completedAt = new Date(this.now()).toISOString();
    this.save();
  }
  private execute(job: FamilyBackupJob, directory: string, receiptFile: string) {
    const command = this.config.commands[job.request.kind];
    if (!command) throw new Error("Recovery command missing");
    return new Promise<void>((resolveJob, reject) => {
      const child = spawn(command[0] ?? "", command.slice(1), {
        cwd: directory,
        env: {
          ...process.env,
          HELIX_FAMILY_BACKUP_REQUEST_FILE: join(directory, "request.json"),
          HELIX_FAMILY_BACKUP_RECEIPT_FILE: receiptFile,
        },
        stdio: "ignore",
        shell: false,
      });
      // No automatic retry: a timed-out command may have produced an uncertain side effect.
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.config.timeoutSeconds * 1000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new UnknownRecoveryOutcome("Unknown execution outcome"));
        } else if (code === 0) resolveJob();
        else reject(new Error("Recovery command failed"));
      });
    });
  }
  status(): FamilyBackupStatus {
    const completed = [...this.state.jobs]
      .reverse()
      .filter((job) => job.status === "completed" && job.receipt);
    const latest = completed.find((job) => job.request.kind === "backup");
    const alerts: FamilyBackupStatus["alerts"] = [];
    if (!latest) alerts.push("backup_missing");
    else if (
      this.now() - Date.parse(latest.createdAt) >
      2 * this.state.policy.intervalMinutes * 60000
    )
      alerts.push("backup_stale");
    if (
      !completed.some(
        (job) => job.receipt?.verifiedAt && job.receipt.backupId === latest?.receipt?.backupId,
      )
    )
      alerts.push("verification_missing");
    if (!completed.some((job) => job.receipt?.restoredAt)) alerts.push("restore_drill_missing");
    if (this.state.jobs.some((job) => job.status === "unknown")) alerts.push("unknown_job");
    const health = this.now() - this.healthCheckedAt <= 30000 ? this.healthy : null;
    if (health === false) alerts.push("application_unavailable");
    return {
      protocol: familyBackupProtocol,
      binding: this.config.binding,
      capabilities: (["backup", "verify", "restore"] as const).filter(
        (kind) => this.config.commands[kind] !== undefined,
      ),
      scheduler: this.config.scheduler,
      owner: this.state.owner,
      policy: this.state.policy,
      minimumRetentionDays: this.config.minimumRetentionDays,
      destinations: this.config.destinations,
      requiredCoverage: this.config.requiredCoverage,
      observedAt: new Date(this.now()).toISOString(),
      applicationHealthy: health,
      alerts,
      jobs: this.state.jobs.slice(-100),
    };
  }
  start() {
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {
        process.stderr.write('{"event":"recovery_worker_failed"}\n');
      });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await this.running;
  }
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 65536) throw new BackupWorkerError(413, "Recovery request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function recoveryServer(worker: FamilyBackupWorker) {
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const payload =
        request.method === "POST" && path.endsWith("/jobs")
          ? familyBackupRequest.parse(await body(request))
          : undefined;
      if (path === "/healthz" && request.method === "GET") {
        response.end('{"status":"ready"}');
        return;
      }
      const key = worker.authenticate(
        request,
        payload?.kind === "restore" ? "restore" : request.method === "GET" ? "read" : "manage",
      );
      let result: unknown;
      if (path === "/v1/family-operations/status" && request.method === "GET")
        result = worker.status();
      else if (path === "/v1/family-operations/policy" && request.method === "PUT")
        result = worker.setPolicy(await body(request));
      else if (path === "/v1/family-operations/jobs" && payload) {
        result = worker.request(
          payload,
          typeof request.headers["x-helix-recovery-authority-until"] === "string"
            ? request.headers["x-helix-recovery-authority-until"]
            : null,
        );
        response.statusCode = 202;
      } else if (path === "/v1/family-operations/detach" && request.method === "POST") {
        worker.detach(key);
        result = { detached: true };
      } else if (path.startsWith("/v1/family-operations/jobs/") && request.method === "GET") {
        result = worker.state.jobs.find((job) => job.request.id === path.split("/").at(-1));
        if (!result) throw new BackupWorkerError(404, "Recovery job not found.");
      } else throw new BackupWorkerError(404, "Recovery route not found.");
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      request.resume();
      response.statusCode = error instanceof BackupWorkerError ? error.status : 400;
      response.end(
        JSON.stringify({
          error: error instanceof BackupWorkerError ? error.message : "Invalid recovery request.",
        }),
      );
    });
  };
  const tls = worker.config.tls;
  if (
    !tls &&
    !worker.config.privateHttp &&
    !["127.0.0.1", "::1", "localhost"].includes(worker.config.host)
  )
    throw new Error("Recovery API requires TLS or explicit private HTTP behind a trusted edge.");
  const server = tls
    ? httpsServer({ cert: readFileSync(tls.certFile), key: protectedFile(tls.keyFile) }, handler)
    : httpServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 64;
  return server;
}
async function main() {
  const file = process.argv[3];
  if (!file) throw new Error("Usage: family-worker serve /private/worker.json");
  process.umask(0o077);
  const config = workerConfiguration.parse(JSON.parse(protectedFile(file)));
  const environment = z
    .object({ HELIX_RECOVERY_LOCKED: z.literal("1").optional() })
    .parse(process.env);
  if (environment.HELIX_RECOVERY_LOCKED !== "1") {
    privateStateDirectory(config.stateDirectory);
    const child = spawn(
      "flock",
      [
        "--nonblock",
        join(config.stateDirectory, "worker.lock"),
        process.execPath,
        ...process.argv.slice(1),
      ],
      { stdio: "inherit", env: { ...process.env, HELIX_RECOVERY_LOCKED: "1" } },
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => child.kill(signal));
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const worker = new FamilyBackupWorker(config);
  if (process.argv[2] === "resolve") {
    const job = worker.state.jobs.find((value) => value.request.id === process.argv[4]);
    if (!job || job.status !== "unknown" || process.argv[5] !== "--confirmed-stopped")
      throw new Error("Confirm the old command stopped before resolving an unknown operation.");
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    persist(join(config.stateDirectory, "state.json"), worker.state);
    return;
  }
  if (process.argv[2] !== "serve") throw new Error("Unknown recovery worker command");
  const server = recoveryServer(worker);
  server.listen(config.port, config.host, () => {
    worker.start();
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      server.close(() => {
        void worker.close();
      });
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    process.stderr.write('{"event":"recovery_worker_start_failed"}\n');
    process.exitCode = 1;
  });
