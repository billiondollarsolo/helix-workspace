import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { InMemoryConfirmationGate } from "./registry.js";
import { PostgresPendingActionStore } from "./pending-actions-postgres-store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface PendingActionRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly tool_id: string;
  readonly input: unknown;
  readonly status: "pending_confirmation" | "confirmed" | "cancelled" | "expired";
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly trace_id: string | null;
  readonly result: unknown;
  readonly error: string | null;
}

describe("PostgresPendingActionStore", () => {
  it("persists trace ids and nullable execution fields when creating pending actions", async () => {
    const createdAt = new Date("2026-05-20T12:00:00.000Z");
    const expiresAt = new Date("2026-05-20T12:15:00.000Z");
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);

    const created = await store.create({
      orgId: "org-1",
      actorId: "actor-1",
      toolId: "platform.test",
      input: { value: true },
      createdAt,
      expiresAt,
      traceId: "trace-create-1",
    });
    const selected = await store.get(created.id);

    expect(created).toEqual({
      id: "pending-1",
      orgId: "org-1",
      actorId: "actor-1",
      toolId: "platform.test",
      input: { value: true },
      status: "pending_confirmation",
      createdAt,
      expiresAt,
      decidedAt: null,
      traceId: "trace-create-1",
      result: null,
      error: null,
    });
    expect(selected).toEqual(created);
    expect(database.calls[0]?.text).toContain("insert into pending_actions");
    expect(database.calls[0]?.text).toContain("trace_id");
    expect(database.calls[0]?.text).toContain("result");
    expect(database.calls[0]?.text).toContain("error");
    expect(database.calls[0]?.values).toContain("trace-create-1");
  });

  it("persists confirmed execution result and replaces the execution trace id", async () => {
    const decidedAt = new Date("2026-05-20T13:00:00.000Z");
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const created = await store.create(createActionInput({ traceId: "trace-create-1" }));

    const confirmed = await store.decide({
      id: created.id,
      actorId: "actor-1",
      status: "confirmed",
      decidedAt,
    });
    const executed = await store.recordExecution({
      id: created.id,
      actorId: "actor-1",
      traceId: "trace-run-1",
      result: { ok: true, count: 2 },
    });
    const selected = await store.get(created.id);

    expect(confirmed).toMatchObject({
      status: "confirmed",
      decidedAt,
      traceId: "trace-create-1",
      result: null,
      error: null,
    });
    expect(executed).toMatchObject({
      status: "confirmed",
      traceId: "trace-run-1",
      result: { ok: true, count: 2 },
      error: null,
    });
    expect(selected).toEqual(executed);
    expect(database.calls[2]?.text).toContain("trace_id = coalesce");
    expect(database.calls[2]?.text).toContain("and status = 'confirmed'");
    expect(database.calls[2]?.values).toContain("trace-run-1");
    expect(database.calls[2]?.values).toContainEqual({ ok: true, count: 2 });
  });

  it("persists execution errors while preserving an existing trace id when omitted", async () => {
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const created = await store.create(createActionInput({ traceId: "trace-create-1" }));
    await store.decide({
      id: created.id,
      actorId: "actor-1",
      status: "confirmed",
      decidedAt: new Date("2026-05-20T14:00:00.000Z"),
    });

    const executed = await store.recordExecution({
      id: created.id,
      actorId: "actor-1",
      error: "Tool invocation failed",
    });
    const selected = await store.get(created.id);

    expect(executed).toMatchObject({
      traceId: "trace-create-1",
      result: null,
      error: "Tool invocation failed",
    });
    expect(selected).toEqual(executed);
    expect(database.calls[2]?.values).toContain("Tool invocation failed");
  });

  it("maps deny to cancelled status and prevents cancelled actions from recording execution", async () => {
    const actor = {
      id: "actor-1",
      orgId: "org-1",
      type: "user" as const,
    };
    const decidedAt = new Date("2026-05-20T15:00:00.000Z");
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const gate = new InMemoryConfirmationGate(store);
    const pending = await gate.queue({
      tool: testTool,
      actor,
      input: { value: true },
      traceId: "trace-create-1",
    });

    const denied = await gate.deny({ id: pending.id, actor, decidedAt });
    const execution = await gate.recordExecution({
      id: pending.id,
      actor,
      traceId: "trace-run-1",
      result: { ok: true },
      error: "should-not-persist",
    });
    const selected = await store.get(pending.id);

    expect(denied).toMatchObject({
      id: pending.id,
      status: "cancelled",
      traceId: "trace-create-1",
    });
    expect(execution).toBeNull();
    expect(selected).toMatchObject({
      status: "cancelled",
      decidedAt,
      traceId: "trace-create-1",
      result: null,
      error: null,
    });
    expect(database.calls[1]?.values).toContain("cancelled");
    expect(database.calls[2]?.text).toContain("and status = 'confirmed'");
  });

  it("expires only past-due pending actions and returns the affected rows", async () => {
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const stale = await store.create({
      orgId: "org-1",
      actorId: "actor-1",
      toolId: "platform.test",
      input: { value: true },
      createdAt: new Date("2026-05-21T11:00:00.000Z"),
      expiresAt: new Date("2026-05-21T11:10:00.000Z"),
    });
    await store.create({
      orgId: "org-1",
      actorId: "actor-1",
      toolId: "platform.test",
      input: { value: true },
      createdAt: new Date("2026-05-21T11:55:00.000Z"),
      expiresAt: new Date("2026-05-21T13:00:00.000Z"),
    });

    const expired = await store.expireStale({ now: new Date("2026-05-21T12:00:00.000Z") });

    expect(expired).toHaveLength(1);
    expect(expired[0]?.id).toBe(stale.id);
    expect(expired[0]?.status).toBe("expired");
    expect(await store.get(stale.id)).toMatchObject({ status: "expired" });
    const expireCall = database.calls.find((call) =>
      call.text.includes("set status = 'expired'"),
    );
    expect(expireCall?.text).toContain("for update skip locked");
  });
});

const testTool = {
  id: "platform.test",
  description: "Test tool",
  permission: "platform.write",
  sideEffects: "write",
  inputSchema: {
    parse: () => ({ value: true }),
    toJsonSchema: () => ({ type: "object" }),
  },
  outputSchema: {
    parse: (value: unknown) => value,
    toJsonSchema: () => ({ type: "object" }),
  },
  handler: async () => ({}),
} as const;

function createActionInput(input: { readonly traceId?: string } = {}) {
  return {
    orgId: "org-1",
    actorId: "actor-1",
    toolId: "platform.test",
    input: { value: true },
    createdAt: new Date("2026-05-20T12:00:00.000Z"),
    expiresAt: new Date("2026-05-20T12:15:00.000Z"),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
}

function createPendingActionsSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const rows = new Map<string, PendingActionRow>();
  let nextId = 1;

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$");
    calls.push({ text, values });
    if (text.includes("insert into pending_actions")) {
      const row: PendingActionRow = {
        id: `pending-${String(nextId)}`,
        org_id: values[0] as string,
        actor_id: values[1] as string,
        tool_id: values[2] as string,
        input: values[3],
        status: values[4] as PendingActionRow["status"],
        expires_at: values[5] as Date,
        created_at: values[6] as Date,
        decided_at: values[7] as Date | null,
        trace_id: values[8] as string | null,
        result: values[9] ?? null,
        error: values[10] as string | null,
      };
      nextId += 1;
      rows.set(row.id, row);
      return Promise.resolve([row]);
    }
    if (text.includes("set status = 'expired'")) {
      const now = values[0] as Date;
      const limit = values[1] as number;
      const expired: PendingActionRow[] = [];
      for (const row of rows.values()) {
        if (expired.length >= limit) {
          break;
        }
        if (row.status === "pending_confirmation" && row.expires_at.getTime() <= now.getTime()) {
          const updated: PendingActionRow = { ...row, status: "expired", decided_at: now };
          rows.set(row.id, updated);
          expired.push(updated);
        }
      }
      return Promise.resolve(expired);
    }
    if (text.includes("from pending_actions")) {
      const row = rows.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (text.includes("set status =")) {
      const id = values[2] as string;
      const actorId = values[3] as string;
      const row = rows.get(id);
      if (row === undefined || row.actor_id !== actorId || row.status !== "pending_confirmation") {
        return Promise.resolve([]);
      }
      const updated: PendingActionRow = {
        ...row,
        status: values[0] as PendingActionRow["status"],
        decided_at: values[1] as Date,
      };
      rows.set(id, updated);
      return Promise.resolve([updated]);
    }
    if (text.includes("trace_id = coalesce")) {
      const id = values[3] as string;
      const actorId = values[4] as string;
      const row = rows.get(id);
      if (row === undefined || row.actor_id !== actorId || row.status !== "confirmed") {
        return Promise.resolve([]);
      }
      const updated: PendingActionRow = {
        ...row,
        trace_id: (values[0] as string | null) ?? row.trace_id,
        result: values[1] ?? null,
        error: values[2] as string | null,
      };
      rows.set(id, updated);
      return Promise.resolve([updated]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
