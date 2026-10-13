import { parseEdgeCertificate, type EdgeCertificateSummary } from "./certificate.js";
import { EdgeNotRunningError } from "./caddy-target.js";
import type {
  EdgeCertificateBundle,
  PostgresEdgeCertificateStore,
  StoredEdgeCertificate,
} from "./store.js";

/** How the deployment told the edge to obtain its certificate. */
export type EdgeTlsDeploymentSource = "automatic" | "files" | "internal";

export interface EdgeCertificateStatus {
  /** The public address the certificate is for. */
  readonly hostname: string;
  /** Where the certificate in use comes from. */
  readonly source: "automatic" | "uploaded" | "deployment-files" | "internal";
  /** Whether a certificate can be uploaded here, and when not, why. */
  readonly manageable: boolean;
  readonly unavailableReason: string | null;
  /** The certificate served right now; null when the edge cannot be reached. */
  readonly served: EdgeCertificateSummary | null;
  readonly uploaded: (EdgeCertificateSummary & { readonly updatedAt: string }) | null;
  /**
   * Whether the edge serves what is configured here: the uploaded certificate,
   * or after its removal anything else. Null when the edge cannot be reached.
   */
  readonly applied: boolean | null;
}

export interface EdgeCertificateTarget {
  write(bundle: EdgeCertificateBundle | null): Promise<boolean>;
  reload(): Promise<void>;
}

export interface EdgeCertificateServiceOptions {
  readonly hostname: string;
  readonly deploymentSource: EdgeTlsDeploymentSource;
  readonly singleTenant: boolean;
  readonly store: Pick<PostgresEdgeCertificateStore, "get" | "readBundle" | "save" | "clear">;
  /** Null when this deployment has no edge Helix can hand a certificate to. */
  readonly target: EdgeCertificateTarget | null;
  readonly probe: () => Promise<EdgeCertificateSummary | null>;
  /** Runs `work` in its own committed transaction scoped to the organization. */
  readonly inOrganization: <T>(orgId: string, work: () => Promise<T>) => Promise<T>;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  /** When to hand a change to the edge after it was requested. */
  readonly applyDelaysMs?: readonly number[] | undefined;
}

/** A served certificate that will not match is reloaded for at most this often. */
const MISMATCH_RELOAD_INTERVAL_MS = 10 * 60 * 1000;
/** The request that stores a change commits shortly after it asks for this. */
const DEFAULT_APPLY_DELAYS_MS = [300, 1_500, 5_000] as const;

export class EdgeCertificateService {
  private queue: Promise<unknown> = Promise.resolve();
  private lastMismatchReloadAt = 0;

  constructor(private readonly options: EdgeCertificateServiceOptions) {}

  private unavailableReason(): string | null {
    if (!this.options.singleTenant) {
      return "The certificate for this address is managed by the platform operator.";
    }
    if (this.options.deploymentSource === "files") {
      return "This deployment serves a certificate from files on the server. Replace those files and restart the edge to change it.";
    }
    if (this.options.target === null) {
      return "Certificate management is not set up for this deployment.";
    }
    return null;
  }

  get manageable(): boolean {
    return this.unavailableReason() === null;
  }

  async status(orgId: string): Promise<EdgeCertificateStatus> {
    const unavailableReason = this.unavailableReason();
    const [stored, served] = await Promise.all([
      unavailableReason === null ? this.options.store.get(orgId) : Promise.resolve(null),
      this.options.probe(),
    ]);
    const uploaded = stored === null ? null : { ...stored.summary, updatedAt: stored.updatedAt };
    return {
      hostname: this.options.hostname,
      source:
        uploaded !== null
          ? "uploaded"
          : this.options.deploymentSource === "files"
            ? "deployment-files"
            : this.options.deploymentSource,
      manageable: unavailableReason === null,
      unavailableReason,
      served,
      uploaded,
      applied:
        served === null
          ? null
          : uploaded === null
            ? true
            : served.fingerprintSha256 === uploaded.fingerprintSha256,
    };
  }

  /** Checks and stores the certificate. Throws EdgeCertificateError when it is unusable. */
  async upload(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  }): Promise<StoredEdgeCertificate> {
    const parsed = parseEdgeCertificate({
      certificatePem: input.certificatePem,
      privateKeyPem: input.privateKeyPem,
      hostname: this.options.hostname,
      now: (this.options.now ?? (() => new Date()))(),
    });
    return this.options.store.save({
      orgId: input.orgId,
      actorId: input.actorId,
      chainPem: parsed.chainPem,
      keyPem: parsed.keyPem,
      summary: parsed.summary,
    });
  }

  remove(orgId: string): Promise<StoredEdgeCertificate | null> {
    return this.options.store.clear(orgId);
  }

  /**
   * Hands the stored state to the edge once the request that changed it has
   * committed. Later attempts cover a slow commit; each is a no-op when the
   * edge already has the right bundle.
   */
  requestApply(orgId: string): void {
    for (const delay of this.options.applyDelaysMs ?? DEFAULT_APPLY_DELAYS_MS) {
      setTimeout(() => {
        void this.apply(orgId).catch((error: unknown) => this.options.onError?.(error));
      }, delay).unref();
    }
  }

  /** Makes the edge serve what is stored. Runs one at a time. */
  apply(orgId: string): Promise<"unchanged" | "reloaded"> {
    const run = this.queue.then(() => this.applyNow(orgId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyNow(orgId: string): Promise<"unchanged" | "reloaded"> {
    const { target } = this.options;
    if (target === null || !this.manageable) return "unchanged";
    const bundle = await this.options.inOrganization(orgId, () =>
      this.options.store.readBundle(orgId),
    );
    let reload = await target.write(bundle);
    if (!reload && bundle !== null) {
      // The bundle is in place; make sure the edge has actually loaded it.
      const served = await this.options.probe();
      const now = (this.options.now ?? (() => new Date()))().getTime();
      if (
        served !== null &&
        served.fingerprintSha256 !== bundle.fingerprintSha256 &&
        now - this.lastMismatchReloadAt >= MISMATCH_RELOAD_INTERVAL_MS
      ) {
        this.lastMismatchReloadAt = now;
        reload = true;
      }
    }
    if (!reload) return "unchanged";
    try {
      await target.reload();
    } catch (error) {
      // Nothing to reload: the edge reads the folder when it starts.
      if (error instanceof EdgeNotRunningError) return "unchanged";
      throw error;
    }
    return "reloaded";
  }
}

export interface EdgeCertificateReconcilerOptions {
  readonly service: Pick<EdgeCertificateService, "apply" | "status" | "manageable">;
  readonly orgId: string;
  readonly intervalMs?: number | undefined;
  readonly onReloaded?: (() => void) | undefined;
  readonly onExpiring?:
    ((input: { readonly hostname: string; readonly days: number }) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

/**
 * Keeps the edge's certificate folder equal to what is stored: after a
 * restore, a lost volume, or a change made on another replica. Also says so,
 * once a day, while an uploaded certificate is within 30 days of expiring,
 * because nothing renews an uploaded certificate.
 */
export class EdgeCertificateReconciler {
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private lastExpiryWarningAt = 0;

  constructor(private readonly options: EdgeCertificateReconcilerOptions) {}

  start(): void {
    if (this.timer !== undefined || !this.options.service.manageable) return;
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs ?? 60_000);
    this.timer.unref();
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  private runScheduled(): Promise<void> {
    this.activeRun ??= this.runOnce()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.activeRun = undefined;
      });
    return this.activeRun;
  }

  async runOnce(): Promise<void> {
    if ((await this.options.service.apply(this.options.orgId)) === "reloaded") {
      this.options.onReloaded?.();
    }
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (now - this.lastExpiryWarningAt < DAY_MS) return;
    const { uploaded, hostname } = await this.options.service.status(this.options.orgId);
    if (uploaded === null) return;
    const days = Math.floor((new Date(uploaded.notAfter).getTime() - now) / DAY_MS);
    if (days <= EXPIRY_WARNING_DAYS) {
      this.lastExpiryWarningAt = now;
      this.options.onExpiring?.({ hostname, days });
    }
  }
}
