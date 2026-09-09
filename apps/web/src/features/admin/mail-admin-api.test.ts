import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  createMailProvider,
  createRoutingRule,
  deleteRoutingRule,
  fetchMailDmarc,
  fetchMailProviders,
  fetchMailDomains,
  fetchMailOperations,
  fetchSpamSettings,
  generateDkimKey,
  removeMailSuppression,
  replayDeadLetter,
  saveMailJournalSettings,
  setDefaultMailProvider,
} from "./mail-admin-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mail-admin-api", () => {
  let fetchImpl: ReturnType<typeof vi.fn<AuthFetch>>;

  beforeEach(() => {
    fetchImpl = vi.fn<AuthFetch>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches outbound providers from /api/admin/mail/providers", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        providers: [
          {
            id: "p-1",
            name: "Primary SES",
            kind: "ses",
            isDefault: true,
            enabled: true,
            config: { apiKeyRef: "env:KEY", region: "us-east-1" },
          },
        ],
      }),
    );

    const result = await fetchMailProviders(fetchImpl);
    expect(result.providers[0]?.kind).toBe("ses");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/mail/providers", {
      method: "GET",
    });
  });

  it("POSTs a new provider with kind-specific config", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        id: "p-2",
        name: "SMTP relay",
        kind: "smtp",
        isDefault: false,
        enabled: true,
        config: { host: "smtp.example", port: 587 },
      }),
    );

    const provider = await createMailProvider(
      {
        name: "SMTP relay",
        kind: "smtp",
        config: { host: "smtp.example", port: 587 },
      },
      fetchImpl,
    );
    expect(provider.kind).toBe("smtp");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/providers");
    expect(init?.method).toBe("POST");
  });

  it("PATCHes the provider to set its default status", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        id: "p-9",
        name: "SMTP",
        kind: "smtp",
        config: {},
        isDefault: true,
        enabled: true,
      }),
    );

    await setDefaultMailProvider("p-9", fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/providers/p-9");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ isDefault: true }));
  });

  it("fetches canonical mail domains with DKIM keys", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        domains: [
          {
            id: "d-1",
            domain: "mail.helix.io",
            status: "verified",
            isPrimary: true,
            mailEnabled: true,
            providerId: null,
            dkimKeys: [{ id: "k-1", selector: "sel1", status: "active" }],
          },
        ],
      }),
    );

    const result = await fetchMailDomains(fetchImpl);
    expect(result.domains[0]?.dkimKeys[0]?.status).toBe("active");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/mail/domains", { method: "GET" });
  });

  it("POSTs DKIM key generation to the canonical domain endpoint", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ key: { id: "k-1", selector: "helix-1", status: "active" } }),
    );

    await generateDkimKey("d-1", "helix-1", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/admin/mail/domains/d-1/dkim");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ selector: "helix-1", keyBits: 2048 }),
    });
  });

  it("fetches the DMARC deliverability summary", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        summary: {
          dmarcPassRate: 0.98,
          spfPassRate: 0.95,
          dkimPassRate: 0.99,
          messagesEvaluated: 100,
          windowDays: 7,
        },
        reports: [],
      }),
    );

    const result = await fetchMailDmarc(fetchImpl);
    expect(result.summary?.dmarcPassRate).toBeCloseTo(0.98);
  });

  it("creates and deletes routing rules", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        rule: {
          id: "r-1",
          name: "Helix catch-all",
          isEnabled: true,
          priority: 10,
          match: { recipientPattern: "*@helix.io" },
          actionKind: "mailbox",
          action: { mailbox: "team" },
        },
      }),
    );

    await createRoutingRule(
      {
        name: "Helix catch-all",
        recipientPattern: "*@helix.io",
        senderPattern: "*@customer.example",
        subjectContains: "urgent",
        headerName: "X-Project",
        headerContains: "alpha",
        actionKind: "mailbox",
        destination: "team",
        stopProcessing: true,
        isEnabled: true,
        priority: 10,
      },
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(typeof body === "string" ? body : "{}")).toEqual({
      name: "Helix catch-all",
      isEnabled: true,
      priority: 10,
      match: {
        recipientPattern: "*@helix.io",
        senderPattern: "*@customer.example",
        subjectContains: "urgent",
        headerName: "X-Project",
        headerContains: "alpha",
      },
      actionKind: "mailbox",
      action: { mailbox: "team", stopProcessing: true },
    });

    fetchImpl.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteRoutingRule("r-1", fetchImpl);
    const [url, init] = fetchImpl.mock.calls[1] ?? [];
    expect(url).toBe("/api/admin/mail/routing-rules/r-1");
    expect(init?.method).toBe("DELETE");
  });

  it("fetches spam settings from /api/admin/mail/spam", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        enabled: true,
        threshold: 5,
        rejectThreshold: 12,
        daemonStatus: "running",
        rulesetVersion: "2026.05",
        taggedLast24h: 12,
      }),
    );

    const result = await fetchSpamSettings(fetchImpl);
    expect(result.daemonStatus).toBe("running");
    expect(result.threshold).toBe(5);
  });

  it("loads delivery operations and sends reasoned recovery actions", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValueOnce(jsonResponse({ events: [] }))
      .mockResolvedValueOnce(jsonResponse({ suppressions: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          journal: {
            enabled: false,
            retentionDays: 2555,
            entryCount: 0,
            lastJournaledAt: null,
            updatedAt: null,
          },
        }),
      );
    await expect(fetchMailOperations(fetchImpl)).resolves.toEqual({
      deadLetters: [],
      events: [],
      suppressions: [],
      journal: {
        enabled: false,
        retentionDays: 2555,
        entryCount: 0,
        lastJournaledAt: null,
        updatedAt: null,
      },
    });

    fetchImpl.mockResolvedValue(jsonResponse({ status: "ok" }));
    await replayDeadLetter("out-1", "provider recovered", fetchImpl);
    await removeMailSuppression("sup-1", "recipient confirmed", fetchImpl);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "/api/admin/mail/journal",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      "/api/admin/mail/outbound/out-1/replay",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "provider recovered" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      6,
      "/api/admin/mail/outbound/suppressions/sup-1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ reason: "recipient confirmed" }),
      }),
    );

    fetchImpl.mockResolvedValue(
      jsonResponse({
        journal: {
          enabled: true,
          retentionDays: 3650,
          entryCount: 0,
          lastJournaledAt: null,
          updatedAt: "2026-09-03T00:00:00Z",
        },
      }),
    );
    await saveMailJournalSettings({ enabled: true, retentionDays: 3650 }, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/admin/mail/journal",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: true, retentionDays: 3650 }),
      }),
    );
  });

  it("throws a descriptive error on a non-OK response", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ error: "Missing required scope" }, 403));

    await expect(fetchMailProviders(fetchImpl)).rejects.toThrow(/Missing required scope/u);
  });

  it("throws on a malformed but OK response", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ providers: [{ id: "x" }] }));

    await expect(fetchMailProviders(fetchImpl)).rejects.toThrow(/malformed/u);
  });
});
