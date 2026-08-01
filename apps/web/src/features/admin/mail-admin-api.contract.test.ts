/* Payload contracts for the mail admin views.
 *
 * These fixtures are captured verbatim from a running backend, not written to
 * match the client schema. That distinction is the point: the Sending domains
 * view shipped demanding `spf`, `dkim`, `dmarc` and `dkimKeys` from a route
 * that returned none of them, so `parseResponse` threw
 *
 *   Failed to load sending domains: malformed response.
 *
 * the moment an org had one sending domain. Both sides typechecked — the
 * server returned its record type, the client parsed into its zod schema, and
 * nothing compared the two. Only a real payload catches that.
 *
 * When a route's shape changes, re-capture the fixture from the server rather
 * than editing it to suit the schema.
 */

import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import { fetchMailProviders, fetchSendingDomains } from "./mail-admin-api";

function respondWith(payload: unknown): AuthFetch {
  return vi.fn<AuthFetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("GET /api/admin/mail/sending-domains", () => {
  /* Captured from a live stack after migration 0086 linked sending domains to
     their admin_domains parent, which is what makes spf/dkim/dmarc reachable. */
  const payload = {
    domains: [
      {
        id: "b2edcde9-fbc1-4085-8ec2-aab4c4a3eaeb",
        orgId: "00000000-0000-4000-8000-000000000100",
        domain: "send-demo.helix.local",
        isDefault: false,
        verifiedAt: null,
        providerId: null,
        createdAt: "2026-07-30T22:36:05.499Z",
        updatedAt: "2026-07-30T22:36:05.499Z",
        spf: "pending",
        dkim: "pending",
        dmarc: "pending",
        dkimKeys: [],
      },
    ],
  };

  it("parses what the server actually sends", async () => {
    const result = await fetchSendingDomains(respondWith(payload));
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]?.domain).toBe("send-demo.helix.local");
  });

  it("carries the DNS posture the view renders", async () => {
    const result = await fetchSendingDomains(respondWith(payload));
    expect(result.domains[0]?.spf).toBe("pending");
    expect(result.domains[0]?.dkim).toBe("pending");
    expect(result.domains[0]?.dmarc).toBe("pending");
  });

  it("fails loudly when the DNS fields go missing again", async () => {
    /* The exact regression: a server that stops joining to admin_dns_records
       must break this test, not render three badges that mean nothing. */
    const withoutDnsPosture = {
      domains: [
        {
          id: payload.domains[0]?.id,
          orgId: payload.domains[0]?.orgId,
          domain: payload.domains[0]?.domain,
          isDefault: false,
          verifiedAt: null,
          providerId: null,
          createdAt: payload.domains[0]?.createdAt,
          updatedAt: payload.domains[0]?.updatedAt,
        },
      ],
    };

    await expect(fetchSendingDomains(respondWith(withoutDnsPosture))).rejects.toThrow(
      /malformed response/,
    );
  });

  it("accepts a domain carrying DKIM keys", async () => {
    const withKeys = {
      domains: [
        {
          ...payload.domains[0],
          dkim: "verified",
          dkimKeys: [
            { id: "3f1b0c22-9a44-4f0e-8b1a-2c7d5e6f8a90", selector: "helix2026", status: "active" },
          ],
        },
      ],
    };

    const result = await fetchSendingDomains(respondWith(withKeys));
    expect(result.domains[0]?.dkimKeys[0]?.selector).toBe("helix2026");
    expect(result.domains[0]?.dkimKeys[0]?.status).toBe("active");
  });
});

describe("GET /api/admin/mail/providers", () => {
  it("parses what the server actually sends", async () => {
    // Captured live; `config` is redacted server-side to a key reference.
    const payload = {
      providers: [
        {
          id: "7c2a1f80-0b3d-4a1e-9f22-1d4e5a6b7c88",
          name: "Primary SES",
          kind: "ses",
          isDefault: true,
          enabled: true,
          config: { apiKeyRef: "env:SES_KEY", region: "us-east-1" },
        },
      ],
    };

    const result = await fetchMailProviders(respondWith(payload));
    expect(result.providers[0]?.kind).toBe("ses");
  });
});
