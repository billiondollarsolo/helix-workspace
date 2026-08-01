import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  createMailProvider,
  createRoutingRule,
  deleteRoutingRule,
  fetchMailDmarc,
  fetchMailProviders,
  fetchSendingDomains,
  fetchSpamSettings,
  generateDkimKey,
  rotateDkimKey,
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

  it("POSTs set-default to the provider's set-default endpoint", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ providers: [] }));

    await setDefaultMailProvider("p-9", fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/providers/p-9/set-default");
    expect(init?.method).toBe("POST");
  });

  it("fetches sending domains with DKIM keys", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        domains: [
          {
            id: "d-1",
            domain: "mail.helix.io",
            spf: "verified",
            dkim: "pending",
            dmarc: "failed",
            dkimKeys: [{ id: "k-1", selector: "sel1", status: "active" }],
          },
        ],
      }),
    );

    const result = await fetchSendingDomains(fetchImpl);
    expect(result.domains[0]?.dkimKeys[0]?.status).toBe("active");
  });

  it("POSTs DKIM key generation and rotation to the right endpoints", async () => {
    const domain = {
      id: "d-1",
      domain: "mail.helix.io",
      spf: "verified",
      dkim: "verified",
      dmarc: "verified",
      dkimKeys: [],
    };
    fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(domain)));

    await generateDkimKey("d-1", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/admin/mail/sending-domains/d-1/dkim");

    await rotateDkimKey("d-1", fetchImpl);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/admin/mail/sending-domains/d-1/dkim/rotate");
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
    expect(result.summary.dmarcPassRate).toBeCloseTo(0.98);
  });

  it("creates and deletes routing rules", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        id: "r-1",
        matchPattern: "*@helix.io",
        action: "mailbox",
        destination: "team",
        enabled: true,
        priority: 10,
      }),
    );

    await createRoutingRule(
      {
        matchPattern: "*@helix.io",
        action: "mailbox",
        destination: "team",
        enabled: true,
        priority: 10,
      },
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");

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

  it("throws a descriptive error on a non-OK response", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ error: "Missing required scope" }, 403));

    await expect(fetchMailProviders(fetchImpl)).rejects.toThrow(/Missing required scope/u);
  });

  it("throws on a malformed but OK response", async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ providers: [{ id: "x" }] }));

    await expect(fetchMailProviders(fetchImpl)).rejects.toThrow(/malformed/u);
  });
});
