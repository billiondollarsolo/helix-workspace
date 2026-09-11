import type { Actor } from "@helix/sdk-types";
import { actorToolInvocationPrincipal } from "../auth/tool-invocation-principal.js";
import type { AssistantOrchestrator } from "./orchestrator.js";
import { runDueRoutines, type AssistantRoutine, type AssistantRoutineStore } from "./routines.js";

export class AssistantRoutineWorker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AssistantRoutineStore,
    private readonly orchestrator: AssistantOrchestrator,
    private readonly loadActor: (orgId: string, actorId: string) => Promise<Actor | null>,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.run();
    }, this.intervalMs);
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
    return runDueRoutines({
      store: this.store,
      run: async (routine) => this.#execute(routine),
    });
  }

  async #execute(routine: AssistantRoutine): Promise<void> {
    const actor = await this.loadActor(routine.orgId, routine.actorId);
    if (actor === null) throw new Error("Routine actor is unavailable.");
    await this.orchestrator.sendMessage({
      actor,
      principal: actorToolInvocationPrincipal(actor),
      content: routine.prompt,
      ...(routine.conversationId === null ? {} : { conversationId: routine.conversationId }),
    });
  }
}
