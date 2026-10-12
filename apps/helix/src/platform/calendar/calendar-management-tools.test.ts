import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import type { CalendarStore } from "./store.js";
import { registerCalendarTools } from "./tools.js";
import type { CalendarRecord } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const calendarId = "33333333-3333-4333-8333-333333333333";
const foreignCalendarId = "55555555-5555-4555-8555-555555555555";
const actor: Actor = { id: actorId, orgId, type: "user", scopes: ["calendar.write"] };

function calendarRecord(name: string, color: string): CalendarRecord {
  return {
    id: calendarId,
    orgId,
    ownerActorId: actorId,
    name,
    color,
    timezone: "UTC",
    description: null,
    metadata: {},
    syncVersion: 0,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("calendar management tools", () => {
  const writes: unknown[] = [];
  const store = {
    createCalendar: async (input: { name: string; color: string }) => {
      writes.push(["create", input]);
      return calendarRecord(input.name, input.color);
    },
    updateCalendar: async (input: { calendarId: string; name?: string; color?: string }) => {
      writes.push(["update", input]);
      return input.calendarId === calendarId
        ? calendarRecord(input.name ?? "Team", input.color ?? "teal")
        : null;
    },
    deleteCalendar: async (input: { calendarId: string }) => input.calendarId === calendarId,
  } as unknown as CalendarStore;
  const registry = createToolRegistry();
  registerCalendarTools(registry, { store });

  it("declares delete as a confirmed, destructive write", () => {
    expect(registry.get("calendar.calendar.create")).toMatchObject({
      permission: "calendar.write",
      sideEffects: "write",
    });
    expect(registry.get("calendar.calendar.delete")).toMatchObject({
      sideEffects: "destructive",
      confirmationRequired: true,
    });
  });

  it("creates and updates calendars as the calling actor", async () => {
    const created = await registry.invoke(
      "calendar.calendar.create",
      { name: "Team", color: "teal" },
      { actor },
    );
    expect(created.ok).toBe(true);
    const renamed = await registry.invoke(
      "calendar.calendar.update",
      { calendarId, name: "Renamed" },
      { actor },
    );
    expect(renamed.ok).toBe(true);
    expect(writes).toEqual([
      ["create", { orgId, actorId, name: "Team", color: "teal" }],
      ["update", { orgId, actorId, calendarId, name: "Renamed", color: undefined }],
    ]);
  });

  it("rejects invalid input and calendars the actor cannot manage", async () => {
    const invalid = await registry.invoke(
      "calendar.calendar.create",
      { name: "", color: "not a colour" },
      { actor },
    );
    const noChange = await registry.invoke("calendar.calendar.update", { calendarId }, { actor });
    const foreignUpdate = await registry.invoke(
      "calendar.calendar.update",
      { calendarId: foreignCalendarId, name: "x" },
      { actor },
    );
    const refusedDelete = await registry.invoke(
      "calendar.calendar.delete",
      { calendarId: foreignCalendarId },
      { actor },
    );
    expect([invalid.ok, noChange.ok, foreignUpdate.ok, refusedDelete.ok]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
