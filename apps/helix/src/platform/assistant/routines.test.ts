import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { InMemoryRoutineStore, nextRunAt, runDueRoutines } from "./routines.js";

const actor: Actor = { id: "actor", orgId: "org", type: "user" };

describe("assistant routines", () => {
  it("runs due routines and reschedules them", async () => {
    const store = new InMemoryRoutineStore();
    const created = await store.create({
      actor,
      name: "Inbox triage",
      prompt: "Summarize new mail.",
      intervalMinutes: 60,
    });
    await store.markRun(created.id, { nextRunAt: new Date("2020-01-01T00:00:00Z") });
    const ran: string[] = [];
    const count = await runDueRoutines({
      store,
      now: new Date("2020-01-01T00:01:00Z"),
      run: async (routine) => {
        ran.push(routine.prompt);
      },
    });
    expect(count).toBe(1);
    expect(ran).toEqual(["Summarize new mail."]);
    const listed = await store.list(actor);
    expect(listed[0]?.lastError).toBeNull();
    expect(listed[0]?.nextRunAt).toBe(
      nextRunAt(new Date("2020-01-01T00:01:00Z"), 60).toISOString(),
    );
  });
});
