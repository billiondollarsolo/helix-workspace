import type { Actor } from "@helix/sdk-types";
import { actorToolInvocationPrincipal } from "../auth/tool-invocation-principal.js";
import type { AssistantOrchestrator } from "../assistant/orchestrator.js";
import {
  formatMailLoopPrompt,
  mailLoopToolIds,
  type AgentDefenderAuth,
} from "./defender-policy.js";
import type { AgentDefenderJob, PostgresAgentDefenderStore } from "./defender-store.js";
import type { MailStore } from "./store.js";

export interface AgentDefenderLoopWorkerOptions {
  readonly defender: PostgresAgentDefenderStore;
  readonly mail: Pick<MailStore, "getThread">;
  readonly orchestrator: AssistantOrchestrator;
  readonly loadActor: (orgId: string, actorId: string) => Promise<Actor | null>;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown, job: AgentDefenderJob) => void;
}

function authFromMetadata(metadata: unknown): AgentDefenderAuth {
  const record =
    typeof metadata === "object" && metadata !== null && "authentication" in metadata
      ? (metadata as { authentication?: Record<string, unknown> }).authentication
      : undefined;
  const read = (key: string) => {
    const value = record?.[key];
    return typeof value === "string" ? value : "none";
  };
  return { spf: read("spf"), dkim: read("dkim"), dmarc: read("dmarc"), arc: read("arc") };
}

export class AgentDefenderLoopWorker {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AgentDefenderLoopWorkerOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    const intervalMs = this.options.intervalMs ?? 15_000;
    this.timer = setInterval(() => {
      void this.run();
    }, intervalMs);
    this.timer.unref();
    void this.run();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async run(): Promise<number> {
    const jobs = await this.options.defender.claimDue(new Date(), 10);
    for (const job of jobs) {
      try {
        const status = await this.#execute(job);
        await this.options.defender.markJob(job.id, { status });
      } catch (error) {
        this.options.onError?.(error, job);
        await this.options.defender.markJob(job.id, {
          status: job.attempts >= 5 ? "failed" : "pending",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return jobs.length;
  }

  async #execute(job: AgentDefenderJob): Promise<"done" | "skipped"> {
    const policy = await this.options.defender.getPolicy(job.orgId, job.agentActorId);
    if (policy === null || !policy.loopEnabled) {
      return "skipped";
    }
    const actor = await this.options.loadActor(job.orgId, job.agentActorId);
    if (actor === null) throw new Error("Loop actor is unavailable.");
    const thread = await this.options.mail.getThread({
      orgId: job.orgId,
      actorId: job.agentActorId,
      threadId: job.threadId,
      excludeHeld: true,
    });
    const message = thread?.messages.at(-1);
    if (thread === null || message === undefined) {
      return "skipped";
    }
    const fromAddress = message.from?.address ?? "";
    const bodyText = message.plainBody ?? (message.bodyFormat === "html" ? "" : message.body);
    await this.options.orchestrator.sendMessage({
      actor,
      principal: actorToolInvocationPrincipal(actor),
      content: formatMailLoopPrompt({
        fromAddress,
        subject: thread.subject,
        bodyText,
        auth: authFromMetadata(undefined),
        messageId: job.messageId,
        canary: job.canary,
      }),
      toolGroups: ["mail"],
      webSearch: false,
      toolIds: mailLoopToolIds(policy.allowSend && policy.receiveMode === "allowlist"),
      metadata: {
        trigger: "inbound_email",
        messageId: job.messageId,
        threadId: job.threadId,
        fromAddress,
        canary: job.canary,
      },
    });
    return "done";
  }
}
