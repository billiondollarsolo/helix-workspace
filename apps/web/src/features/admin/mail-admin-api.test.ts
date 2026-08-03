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
  patchMailProvider,
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
    // 201 with the record under `provider` — the write routes never return it bare.
    fetchImpl.mockResolvedValue(
      jsonResponse(
        {
          provider: {
            id: "p-2",
            name: "SMTP relay",
            kind: "smtp",
            isDefault: false,
            enabled: true,
            config: { host: "smtp.example", port: 587 },
          },
        },
        201,
      ),
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

  /* There is no `/set-default` route and there never was; this PATCHes the
     provider with the flag the update handler reads. */
  it("PATCHes isDefault onto the provider to promote it", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        provider: {
          id: "p-9",
          name: "Primary SES",
          kind: "ses",
          isDefault: true,
          enabled: true,
          config: { apiKeyRef: "env:KEY" },
        },
      }),
    );

    const provider = await setDefaultMailProvider("p-9", fetchImpl);
    expect(provider.isDefault).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/providers/p-9");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ isDefault: true }));
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

  it("POSTs DKIM rotation to the domain's rotate endpoint", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ key: { id: "k-2", selector: "helix20260803", status: "active" } }),
    );

    const key = await rotateDkimKey("d-1", fetchImpl);
    expect(key.selector).toBe("helix20260803");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/sending-domains/d-1/dkim/rotate");
    expect(init?.method).toBe("POST");
    /* Fastify answers 400 to an empty body under a JSON content-type, so the
       rotate call has to carry one even though it has nothing to say. */
    expect(init?.body).toBe("{}");
  });

  /* This used to send no body and parse a sending domain back. The route wants a
     JSON body and answers `201 { key }`, so every click 400'd while the test
     stayed green against a payload no server ever sent. */
  it("POSTs DKIM key generation and reads back the issued key", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ key: { id: "k-1", selector: "helix20260803", status: "active" } }, 201),
    );

    const key = await generateDkimKey("d-1", fetchImpl);
    expect(key.selector).toBe("helix20260803");
    expect(key.status).toBe("active");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/mail/sending-domains/d-1/dkim");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
  });

  /* The selector is the server's to choose; a client that sent one would have to
     read the domain's keys first, racing every other admin doing the same. */
  it("names no selector when generating a DKIM key", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ key: { id: "k-1", selector: "helix20260803", status: "active" } }, 201),
    );

    await generateDkimKey("d-1", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).not.toContain("selector");
  });

  it("PATCHes a provider and reads the record out of its envelope", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        provider: {
          id: "p-3",
          name: "SMTP relay",
          kind: "smtp",
          isDefault: false,
          enabled: false,
          config: { host: "smtp.example", port: 587 },
        },
      }),
    );

    const provider = await patchMailProvider("p-3", { enabled: false }, fetchImpl);
    expect(provider.enabled).toBe(false);
  });

  /* A write that answers with the record bare is a server drifting off the
     envelope contract, and must read as a failure rather than a silent no-op. */
  it("rejects a provider write that skips the envelope", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        id: "p-4",
        name: "SMTP relay",
        kind: "smtp",
        isDefault: false,
        enabled: true,
        config: { host: "smtp.example", port: 587 },
      }),
    );

    await expect(
      createMailProvider(
        { name: "SMTP relay", kind: "smtp", config: { host: "smtp.example", port: 587 } },
        fetchImpl,
      ),
    ).rejects.toThrow(/malformed/u);
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
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/admin/mail/dmarc");
  });

  /* The pass-rate cards are three numbers; a server that can only back one of
     them must yield no cards, never a 0% that reads as a deliverability
     collapse. `summary: null` is what makes the view drop the header. */
  it("reports no summary when the server cannot state every rate", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        summary: { dmarcPassRate: 0.8, messagesEvaluated: 50, windowDays: 1, reportCount: 1 },
        reports: [],
      }),
    );

    const result = await fetchMailDmarc(fetchImpl);
    expect(result.summary).toBeNull();
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
