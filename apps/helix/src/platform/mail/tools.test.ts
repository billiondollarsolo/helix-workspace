import { describe, expect, it, vi } from "vitest";
import { mailSpamResultSchema } from "@helix/contracts";
import { createMailToolDefinitions } from "./tools.js";
import type { MailStore } from "./store.js";
import { MailFilterNotFoundError, MailInboundActorForbiddenError } from "./errors.js";

function toolById(id: string, storeOverrides: Partial<MailStore> = {}) {
  const updateThreadState = vi.fn<MailStore["updateThreadState"]>().mockResolvedValue(undefined);
  const listFilters = vi.fn<MailStore["listFilters"]>().mockResolvedValue([]);
  const cancelOutbound = vi.fn<MailStore["cancelOutbound"]>().mockResolvedValue(null);
  const store = {
    updateThreadState,
    listFilters,
    cancelOutbound,
    getOutbound: vi.fn().mockResolvedValue(null),
    ...storeOverrides,
  } as unknown as MailStore;
  const tool = createMailToolDefinitions({ store }).find((t) => t.id === id);
  if (tool === undefined) throw new Error(`tool ${id} not registered`);
  return { tool, store, updateThreadState, listFilters, cancelOutbound };
}

describe("mail.spam tool", () => {
  it("is registered", () => {
    expect(
      createMailToolDefinitions({ store: {} as MailStore }).some((t) => t.id === "mail.spam"),
    ).toBe(true);
  });

  it("stamps spam_at when marking spam", async () => {
    const { tool, updateThreadState } = toolById("mail.spam");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool.handler(
      { threadId: "11111111-1111-1111-1111-111111111111", spam: true },
      ctx,
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const update = updateThreadState.mock.calls[0]?.[0];
    expect(update?.patch.spamAt).toBeInstanceOf(Date);
  });

  it("clears spam_at when un-marking (spam:false)", async () => {
    const { tool, updateThreadState } = toolById("mail.spam");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    await tool.handler({ threadId: "11111111-1111-1111-1111-111111111111", spam: false }, ctx);
    const update = updateThreadState.mock.calls[0]?.[0];
    expect(update?.patch.spamAt).toBeNull();
  });

  it("requires the mail.write scope (not mail.read)", () => {
    const { tool } = toolById("mail.spam");
    expect(tool.permission).toBe("mail.write");
  });

  it("mail.spam output validates against the contract", async () => {
    const { tool } = toolById("mail.spam");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = await tool.handler(
      { threadId: "11111111-1111-1111-1111-111111111111", spam: true },
      ctx,
    );
    expect(() => mailSpamResultSchema.parse(out)).not.toThrow();
  });
});

describe("mail.filter.list tool", () => {
  it("is registered and reads via store.listFilters", async () => {
    const now = new Date();
    const listFilters = vi.fn().mockResolvedValue([
      {
        id: "f1",
        name: "Newsletters",
        enabled: true,
        priority: 100,
        criteria: {},
        actions: {},
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const store = {
      listFilters,
    } as unknown as MailStore;
    const tool = createMailToolDefinitions({ store }).find((t) => t.id === "mail.filter.list");
    if (tool === undefined) throw new Error("Missing mail.filter.list tool");
    expect(tool.permission).toBe("mail.read");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool.handler({}, ctx)) as { filters: { id: string; createdAt: string }[] };
    expect(listFilters).toHaveBeenCalledWith("o1", "a1");
    expect(out.filters[0]?.id).toBe("f1");
    expect(typeof out.filters[0]?.createdAt).toBe("string");
  });
});

describe("mail.outbound.cancel tool", () => {
  it("is registered with mail.write and cancels via send service store", async () => {
    const cancelled = {
      id: "out-1",
      messageId: "m1",
      threadId: "t1",
      status: "cancelled",
      undoUntil: new Date("2026-01-01T00:00:30.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      orgId: "o1",
      actorId: "a1",
      outboxId: "ob1",
      envelope: {
        from: { address: "a@b.com" },
        to: [{ address: "c@d.com" }],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        attachments: [],
      },
      sentAt: null,
      cancelledAt: new Date("2026-01-01T00:00:10.000Z"),
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      updatedAt: new Date(),
    };
    const cancelOutbound = vi.fn().mockResolvedValue(cancelled);
    const { tool } = toolById("mail.outbound.cancel", {
      cancelOutbound,
    });
    expect(tool.permission).toBe("mail.write");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool.handler(
      { outboundId: "11111111-1111-1111-1111-111111111111" },
      ctx,
    )) as { outbound: { id: string } | null };
    expect(cancelOutbound).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "a1",
      id: "11111111-1111-1111-1111-111111111111",
    });
    expect(out.outbound?.id).toBe("out-1");
  });

  it("returns null outbound without leaking when cancel is denied", async () => {
    const { tool } = toolById("mail.outbound.cancel", {
      cancelOutbound: vi.fn().mockResolvedValue(null),
    });
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool.handler(
      { outboundId: "11111111-1111-1111-1111-111111111111" },
      ctx,
    )) as { outbound: null };
    expect(out.outbound).toBeNull();
  });
});

describe("mail.alias tools", () => {
  it("registers list/create/delete with least-privilege scopes", () => {
    const tools = createMailToolDefinitions({ store: {} as MailStore });
    const list = tools.find((t) => t.id === "mail.alias.list");
    const create = tools.find((t) => t.id === "mail.alias.create");
    const del = tools.find((t) => t.id === "mail.alias.delete");
    expect(list?.permission).toBe("mail.read");
    expect(create?.permission).toBe("mail.admin");
    expect(del?.permission).toBe("mail.admin");
  });
});

describe("mail.draft tools", () => {
  it("registers draft save/get/list/discard", () => {
    const ids = createMailToolDefinitions({ store: {} as MailStore }).map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "mail.draft.save",
        "mail.draft.get",
        "mail.draft.list",
        "mail.draft.discard",
      ]),
    );
  });
});

describe("mail tool error typing", () => {
  it("throws MailFilterNotFoundError on unknown filter update", async () => {
    const { tool } = toolById("mail.filter.update", {
      updateFilter: vi.fn().mockResolvedValue(null),
    });
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    await expect(
      tool.handler({ id: "11111111-1111-1111-1111-111111111111", name: "x" }, ctx),
    ).rejects.toBeInstanceOf(MailFilterNotFoundError);
  });

  it("throws MailInboundActorForbiddenError for user actors", async () => {
    const { tool } = toolById("mail.inbound.accept");
    const ctx = {
      actor: { id: "a1", orgId: "o1", type: "user" },
    } as never;
    await expect(
      tool.handler(
        {
          from: { address: "a@b.com" },
          to: [{ address: "c@d.com" }],
          bodyText: "hi",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(MailInboundActorForbiddenError);
  });

  it("no mail tool ships without an outputSchema", () => {
    const tools = createMailToolDefinitions({ store: {} as MailStore });
    for (const t of tools) expect(t.outputSchema).toBeDefined();
  });
});
