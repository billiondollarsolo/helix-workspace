import { describe, expect, it, vi } from "vitest";
import { mailSpamResultSchema } from "@helix/contracts";
import { createMailToolDefinitions } from "./tools.js";
import type { MailStore } from "./store.js";
import { MailFilterNotFoundError, MailInboundActorForbiddenError } from "./errors.js";
import { ForbiddenError } from "../../api/api-error.js";

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

describe("reversible mailbox state tools", () => {
  it.each([
    ["mail.unarchive", "archivedAt"],
    ["mail.restore", "deletedAt"],
    ["mail.unsnooze", "snoozedUntil"],
  ] as const)("%s explicitly clears %s", async (toolId, field) => {
    const { tool, updateThreadState } = toolById(toolId);
    await tool.handler({ threadId: "11111111-1111-1111-1111-111111111111" }, {
      actor: { id: "a1", orgId: "o1" },
    } as never);
    expect(updateThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { [field]: null } }),
    );
  });
});

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

describe("mailbox delegation tools", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const delegateId = "22222222-2222-4222-8222-222222222222";
  const orgId = "33333333-3333-4333-8333-333333333333";

  it("lets a delegated request select its owner mailbox while RLS remains authoritative", async () => {
    const getThread = vi.fn<MailStore["getThread"]>().mockResolvedValue(null);
    const { tool } = toolById("mail.thread.get", { getThread });
    await tool.handler(
      { threadId: "44444444-4444-4444-8444-444444444444", mailboxActorId: ownerId },
      { actor: { id: delegateId, orgId } } as never,
    );
    expect(getThread).toHaveBeenCalledWith({
      orgId,
      actorId: ownerId,
      threadId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("sanitizes HTML at the thread response boundary while retaining inert source and plain text", async () => {
    const getThread = vi.fn<MailStore["getThread"]>().mockResolvedValue({
      id: "thread-1",
      subject: "Newsletter",
      preview: "Hello",
      participants: [],
      messages: [
        {
          id: "message-1",
          to: [],
          cc: [],
          bcc: [],
          sentAt: new Date("2026-09-02T12:00:00.000Z"),
          body: '<h1 onclick="alert(1)">Hello</h1><img src="https://tracker.test/pixel"><a href="https://example.com">read</a>',
          bodyFormat: "html",
          plainBody: "Hello\nread",
          hasAttachment: false,
          attachments: [],
        },
      ],
      labels: [],
      archivedAt: null,
      deletedAt: null,
      snoozedUntil: null,
      lastActivity: new Date("2026-09-02T12:00:00.000Z"),
      unread: true,
      starred: false,
      direction: "inbound",
    });
    const { tool } = toolById("mail.thread.get", { getThread });
    const output = (await tool.handler({ threadId: "44444444-4444-4444-8444-444444444444" }, {
      actor: { id: delegateId, orgId },
    } as never)) as {
      readonly thread: {
        readonly messages: readonly {
          readonly body: string;
          readonly source: string;
          readonly plainBody: string;
          readonly remoteContentBlocked: boolean;
        }[];
      };
    };
    const message = output.thread.messages[0];
    expect(message?.body).toBe(
      '<h1>Hello</h1><img/><a href="#helix-link" data-helix-href="https://example.com">read</a>',
    );
    expect(message?.body).not.toMatch(/onclick|tracker\.test/iu);
    expect(message?.source).toContain("onclick");
    expect(message?.plainBody).toBe("Hello\nread");
    expect(message?.remoteContentBlocked).toBe(true);
  });

  it("grants, lists, and revokes only the caller's mailbox", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const grantMailboxDelegate = vi.fn<MailStore["grantMailboxDelegate"]>().mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      actorId: delegateId,
      validFrom: now,
      expiresAt: null,
      createdAt: now,
    });
    const listMailboxDelegates = vi.fn<MailStore["listMailboxDelegates"]>().mockResolvedValue([]);
    const revokeMailboxDelegate = vi
      .fn<MailStore["revokeMailboxDelegate"]>()
      .mockResolvedValue(true);
    const overrides = {
      grantMailboxDelegate,
      listMailboxDelegates,
      revokeMailboxDelegate,
    };
    const ctx = { actor: { id: ownerId, orgId } } as never;

    await toolById("mail.delegate.grant", overrides).tool.handler({ actorId: delegateId }, ctx);
    await toolById("mail.delegate.list", overrides).tool.handler({}, ctx);
    await toolById("mail.delegate.revoke", overrides).tool.handler({ actorId: delegateId }, ctx);

    expect(grantMailboxDelegate).toHaveBeenCalledWith({
      orgId,
      ownerActorId: ownerId,
      delegateActorId: delegateId,
      expiresAt: null,
    });
    expect(listMailboxDelegates).toHaveBeenCalledWith(orgId, ownerId);
    expect(revokeMailboxDelegate).toHaveBeenCalledWith({
      orgId,
      ownerActorId: ownerId,
      delegateActorId: delegateId,
    });
  });
});

describe("mail outbound trust boundary", () => {
  it("rejects a caller-controlled From address before queueing", async () => {
    const createOutbound = vi.fn<MailStore["createOutbound"]>();
    const { tool } = toolById("mail.send", { createOutbound });

    await expect(
      tool.handler(
        {
          from: { address: "executive@example.com" },
          to: [{ address: "recipient@example.com" }],
          cc: [],
          bcc: [],
          subject: "Spoof",
          bodyText: "Body",
          attachments: [],
        },
        {
          actor: {
            id: "actor-1",
            orgId: "org-1",
            email: "alice@example.com",
            displayName: "Alice",
          },
        } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(createOutbound).not.toHaveBeenCalled();
  });

  it("rejects attachment paths and ambiguous content/object references", () => {
    const { tool } = toolById("mail.send");
    const base = {
      to: ["recipient@example.com"],
      subject: "Attachment",
      bodyText: "Body",
    };
    expect(() =>
      tool.inputSchema.parse({ ...base, attachments: [{ path: "/etc/passwd" }] }),
    ).toThrow();
    expect(() =>
      tool.inputSchema.parse({
        ...base,
        attachments: [
          {
            content: "YQ==",
            objectId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      }),
    ).toThrow();
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

  it("passes the flat revision and staged attachment contract to persistence", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const saveDraft = vi.fn<NonNullable<MailStore["saveDraft"]>>().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      actorId: "33333333-3333-4333-8333-333333333333",
      threadId: null,
      envelope: {},
      revision: 2,
      expiresAt: new Date("2026-10-02T12:00:00.000Z"),
      createdAt: now,
      updatedAt: now,
    });
    const { tool } = toolById("mail.draft.save", { saveDraft });
    await tool.handler(
      {
        id: "11111111-1111-4111-8111-111111111111",
        expectedRevision: 1,
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        to: [{ address: "a@b.com" }],
        cc: [],
        bcc: [],
        subject: "Draft",
        bodyText: "Body",
        attachments: [{ objectId: "55555555-5555-4555-8555-555555555555" }],
      },
      {
        actor: {
          id: "33333333-3333-4333-8333-333333333333",
          orgId: "22222222-2222-4222-8222-222222222222",
        },
      } as never,
    );
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        attachmentObjectIds: ["55555555-5555-4555-8555-555555555555"],
      }),
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
