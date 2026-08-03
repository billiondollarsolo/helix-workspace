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
import {
  createMailProvider,
  createRoutingRule,
  createSendingDomain,
  deleteRoutingRule,
  deleteSendingDomain,
  fetchMailDmarc,
  fetchMailProviders,
  fetchRoutingRules,
  fetchSendingDomains,
  fetchSpamSettings,
  generateDkimKey,
  patchMailProvider,
  patchRoutingRule,
  rotateDkimKey,
  setDefaultMailProvider,
} from "./mail-admin-api";

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

/* Every wire target this module issues, in one table.
 *
 * Two of these shipped pointed at routes the backend never registered —
 * `POST /providers/:id/set-default` and `GET /dmarc` — so Deliverability was a
 * permanent 404 banner and "Make default" failed on every click. Nothing caught
 * it: the client typechecked against its own zod schemas and the server against
 * its own handlers, and no test named the URL.
 *
 * `template` is the route as the backend registers it — `:id` and all — and it
 * is the only URL written here: the expected concrete path is the template with
 * `params` substituted in, so the column cannot drift away from the URL under
 * test. It used to be decoration next to a hand-written `path`, which meant the
 * two halves of the contract could be renamed apart while both stayed green.
 *
 * The same templates are listed in the backend's admin-routes.test.ts ("admin
 * console route contract"), which asserts each resolves to a real handler.
 */
interface WireRoute {
  readonly name: string;
  readonly method: string;
  /** The backend's registered route, with `:param` placeholders intact. */
  readonly template: string;
  /** Values the call under test substitutes for the template's placeholders. */
  readonly params?: Readonly<Record<string, string>>;
  readonly call: (fetchImpl: AuthFetch) => Promise<unknown>;
}

/** The template with its placeholders filled — the URL the client must issue. */
function fillTemplate(route: WireRoute): string {
  return route.template.replaceAll(/:(\w+)/gu, (_match, name: string) => {
    const value = route.params?.[name];
    if (value === undefined) {
      throw new Error(`${route.name}: no value for :${name} in ${route.template}`);
    }
    return encodeURIComponent(value);
  });
}

const WIRE_CONTRACT: readonly WireRoute[] = [
  {
    name: "fetchMailProviders",
    method: "GET",
    template: "/api/admin/mail/providers",
    call: (fetchImpl) => fetchMailProviders(fetchImpl),
  },
  {
    name: "createMailProvider",
    method: "POST",
    template: "/api/admin/mail/providers",
    call: (fetchImpl) =>
      createMailProvider({ name: "SES", kind: "ses", config: { region: "us-east-1" } }, fetchImpl),
  },
  {
    name: "patchMailProvider",
    method: "PATCH",
    template: "/api/admin/mail/providers/:id",
    params: { id: "p-1" },
    call: (fetchImpl) => patchMailProvider("p-1", { enabled: false }, fetchImpl),
  },
  {
    name: "setDefaultMailProvider",
    method: "PATCH",
    template: "/api/admin/mail/providers/:id",
    params: { id: "p-1" },
    call: (fetchImpl) => setDefaultMailProvider("p-1", fetchImpl),
  },
  {
    name: "fetchSendingDomains",
    method: "GET",
    template: "/api/admin/mail/sending-domains",
    call: (fetchImpl) => fetchSendingDomains(fetchImpl),
  },
  {
    name: "createSendingDomain",
    method: "POST",
    template: "/api/admin/mail/sending-domains",
    call: (fetchImpl) => createSendingDomain("send.helix.local", fetchImpl),
  },
  {
    name: "deleteSendingDomain",
    method: "DELETE",
    template: "/api/admin/mail/sending-domains/:id",
    params: { id: "d-1" },
    call: (fetchImpl) => deleteSendingDomain("d-1", fetchImpl),
  },
  {
    name: "generateDkimKey",
    method: "POST",
    template: "/api/admin/mail/sending-domains/:id/dkim",
    params: { id: "d-1" },
    call: (fetchImpl) => generateDkimKey("d-1", fetchImpl),
  },
  {
    name: "rotateDkimKey",
    method: "POST",
    template: "/api/admin/mail/sending-domains/:id/dkim/rotate",
    params: { id: "d-1" },
    call: (fetchImpl) => rotateDkimKey("d-1", fetchImpl),
  },
  {
    name: "fetchMailDmarc",
    method: "GET",
    template: "/api/admin/mail/dmarc",
    call: (fetchImpl) => fetchMailDmarc(fetchImpl),
  },
  {
    name: "fetchRoutingRules",
    method: "GET",
    template: "/api/admin/mail/routing-rules",
    call: (fetchImpl) => fetchRoutingRules(fetchImpl),
  },
  {
    name: "createRoutingRule",
    method: "POST",
    template: "/api/admin/mail/routing-rules",
    call: (fetchImpl) =>
      createRoutingRule(
        {
          matchPattern: "*@helix.local",
          action: "mailbox",
          destination: "team",
          enabled: true,
          priority: 10,
        },
        fetchImpl,
      ),
  },
  {
    name: "patchRoutingRule",
    method: "PATCH",
    template: "/api/admin/mail/routing-rules/:id",
    params: { id: "r-1" },
    call: (fetchImpl) => patchRoutingRule("r-1", { enabled: false }, fetchImpl),
  },
  {
    name: "deleteRoutingRule",
    method: "DELETE",
    template: "/api/admin/mail/routing-rules/:id",
    params: { id: "r-1" },
    call: (fetchImpl) => deleteRoutingRule("r-1", fetchImpl),
  },
  {
    name: "fetchSpamSettings",
    method: "GET",
    template: "/api/admin/mail/spam",
    call: (fetchImpl) => fetchSpamSettings(fetchImpl),
  },
];

describe("admin mail client wire contract", () => {
  for (const route of WIRE_CONTRACT) {
    it(`${route.name} issues ${route.method} ${route.template}`, async () => {
      const fetchImpl = vi.fn<AuthFetch>(() =>
        Promise.resolve(new Response("{}", { status: 200 })),
      );

      /* The empty body fails each function's response schema. That is fine and
         deliberate: this test asserts only where the request goes, and the
         payload shapes are covered by the captured fixtures in this file. */
      await route.call(fetchImpl).catch(() => undefined);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe(fillTemplate(route));
      expect(init?.method).toBe(route.method);
    });
  }

  /* A placeholder the table has no value for would otherwise be asserted
     literally — `:id` in the expected URL, matching nothing a client sends. */
  it("refuses a template whose parameters are not all supplied", () => {
    expect(() =>
      fillTemplate({
        name: "unfilled",
        method: "GET",
        template: "/api/admin/mail/sending-domains/:id",
        call: () => Promise.resolve(),
      }),
    ).toThrow(/no value for :id/u);
  });

  it("percent-encodes ids into the path", async () => {
    // A raw id with a slash would otherwise forge a path segment.
    const fetchImpl = vi.fn<AuthFetch>(() => Promise.resolve(new Response("{}", { status: 200 })));
    await deleteRoutingRule("r/1", fetchImpl).catch(() => undefined);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/admin/mail/routing-rules/r%2F1");
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
