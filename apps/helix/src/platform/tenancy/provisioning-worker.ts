import { withJobSpan } from "../observability/job-span.js";
import type { TenantProvisioningRecord, TenantProvisioningStore } from "./provisioning.js";

export type TenantProvisioningWorkerStore = Pick<
  TenantProvisioningStore,
  "claimPending" | "markFailed" | "markWaitingForVerification"
>;

export interface TenantProvisioningStep {
  readonly name: string;
  run(record: TenantProvisioningRecord): Promise<void>;
}

export interface TenantProvisioningWorkerOptions {
  readonly store: TenantProvisioningWorkerStore;
  readonly steps: readonly TenantProvisioningStep[];
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onResult?: (result: TenantProvisioningRunResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TenantProvisioningRunResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

const defaultIntervalMs = 5_000;
const defaultBatchSize = 10;

export class TenantProvisioningWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onResult: ((result: TenantProvisioningRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<TenantProvisioningRunResult> | undefined;

  constructor(private readonly options: TenantProvisioningWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.batchSize = options.batchSize ?? defaultBatchSize;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduledProvisioning();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledProvisioning();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeRun !== undefined) {
      await this.activeRun;
    }
  }

  async runOnce(): Promise<TenantProvisioningRunResult> {
    return withJobSpan("tenant-provisioning", async () => {
      const claimed = await this.options.store.claimPending({ limit: this.batchSize });
      let succeeded = 0;
      let failed = 0;

      for (const record of claimed) {
        const completedSteps = [...record.completedSteps];
        let currentStep = record.currentStep;
        try {
          await withJobSpan(
            "tenant-provisioning.record",
            async () => {
              for (const step of this.options.steps) {
                if (completedSteps.includes(step.name)) {
                  continue;
                }
                currentStep = step.name;
                await step.run(record);
                completedSteps.push(step.name);
              }
              await this.options.store.markWaitingForVerification({
                orgId: record.orgId,
                currentStep: "waiting_for_verification",
                completedSteps,
              });
            },
            { tenant: { orgId: record.orgId } },
          );
          succeeded += 1;
        } catch (error) {
          await this.options.store.markFailed({
            orgId: record.orgId,
            currentStep,
            completedSteps,
            error: errorMessage(error),
          });
          failed += 1;
        }
      }

      return { claimed: claimed.length, succeeded, failed };
    });
  }

  private runScheduledProvisioning(): Promise<TenantProvisioningRunResult> {
    if (this.activeRun !== undefined) {
      return this.activeRun;
    }
    const activeRun = this.runOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.onError?.(error);
        return { claimed: 0, succeeded: 0, failed: 0 };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
