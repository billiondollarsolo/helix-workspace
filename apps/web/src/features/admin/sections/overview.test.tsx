// @vitest-environment jsdom

/* Admin › Overview — the console's landing section.
 *
 * Overview's contract is not "renders some numbers", it is "never reports a
 * state it could not read". Every test below is a variant of that: a refused
 * request must not look like a zero, a pending one must not look like a clean
 * workspace, an absent policy record must not be reported as "not enforced",
 * and one dead query must not blank the four that answered. The happy-path
 * test exists so the failure tests cannot be satisfied by rendering nothing.
 *
 * Three of them are about the page's own behaviour rather than its readings:
 * it must not spend the org's whole per-second request budget in one tick, it
 * must treat a 429 as "ask again later" rather than a verdict, and its
 * headline count must reconcile with the cards it counted. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOverview, prefetchAdminOverviewQueries } from "@/features/admin/sections/overview";
import { adminOverviewQueryKey } from "@/features/admin/admin-overview-api";

/* ------------------------------------------------------------------ */
/* Fixtures — the exact payload shapes the clients validate            */
/* ------------------------------------------------------------------ */

type VerificationStatus = "verified" | "pending" | "failed";

function domainEntry(domain: string, verificationStatus: VerificationStatus, isPrimary = false) {
  return {
    domain: {
      id: `dom-${domain}`,
      orgId: "org-1",
      domain,
      isPrimary,
      verificationStatus,
      verifiedAt: verificationStatus === "verified" ? "2026-01-01T00:00:00Z" : null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    dnsRecords: [],
    /* Required-nullable since the domain registries were unified: the overview
       only reads verification status, but the response schema is shared. */
    sending: null,
    receiving: null,
  };
}

function policy(policyType: string, enabled: boolean, enforcement: string) {
  return {
    id: `policy-${policyType}`,
    orgId: "org-1",
    policyType,
    enabled,
    enforcement,
    settings: {},
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function user(id: string, disabledAt: string | null = null) {
  return {
    id,
    orgId: "org-1",
    type: "user",
    email: `${id}@helix.local`,
    displayName: `User ${id}`,
    scopes: [],
    disabledAt,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function coreApp(id: string, name: string, enabled: boolean) {
  return { id, name, description: `${name} app`, enabled, inRole: true, registered: enabled };
}

interface Workspace {
  readonly domains?: unknown;
  readonly policies?: unknown;
  readonly platform?: unknown;
  readonly users?: unknown;
  readonly coreApps?: unknown;
}

/** A workspace where every rule stays silent: two verified domains, MFA
 *  required, tier ready, two live accounts, one app enabled. */
const CLEAN: Required<Workspace> = {
  domains: { domains: [domainEntry("helix.local", "verified", true)] },
  policies: {
    // external_sharing is runtime-enforced; dlp is recorded-only and must not
    // count as "enforced" merely because enforcement=required is stored.
    policies: [policy("mfa", true, "required"), policy("external_sharing", true, "required")],
  },
  platform: {
    config: { security: { tier: "business" } },
    readiness: { ready: true, requirements: [] },
  },
  users: { users: [user("u-1"), user("u-2")], nextCursor: null },
  coreApps: { role: "all", apps: [coreApp("mail", "Mail", true)] },
};

describe("AdminOverview", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input instanceof Request ? input.url : "";
  }

  /** Serves `GET /api/admin/overview` by composing the same per-source payloads
   *  the five endpoints used to return.
   *
   *  The page reads one request now, but the fixtures stay per source because
   *  that is what the tests are about: a 403 on policies, a 500 on domains, a
   *  source that never answers. The server reports each source's own status
   *  inside one response, so those cases survive the move — which is precisely
   *  the property worth testing, since a naive aggregate would have collapsed
   *  all five into a single failure. */
  async function overviewEnvelope(workspace: Workspace): Promise<unknown> {
    const signal = async (payload: unknown) => {
      if (payload instanceof Response) {
        /* The server reports the source's own message, which is the reason the
           aggregate keeps a per-signal `reason` at all — a 403 saying why beats
           a generic "unavailable". */
        const body = (await payload
          .clone()
          .json()
          .catch(() => ({}))) as { readonly error?: string };
        return {
          status: "unavailable",
          reason: body.error ?? `The service returned HTTP ${String(payload.status)}.`,
        };
      }
      return { status: "ok", data: payload };
    };
    return {
      signals: {
        domains: await signal(workspace.domains),
        policies: await signal(workspace.policies),
        platformConfig: await signal(workspace.platform),
        directory: await signal(workspace.users),
        coreApps: await signal(workspace.coreApps),
      },
    };
  }

  function mockWorkspace(workspace: Workspace) {
    fetchMock.mockImplementation(() => {
      /* `undefined` on any source means "never answers" — with one request that
         is the whole page pending, which is the state the caller is asking for. */
      const pending = [
        workspace.domains,
        workspace.policies,
        workspace.platform,
        workspace.users,
        workspace.coreApps,
      ].some((payload) => payload === undefined);
      if (pending) {
        return new Promise<Response>(() => undefined);
      }
      return overviewEnvelope(workspace).then((body) => Response.json(body));
    });
  }

  /** Polls with real timers — five queries settle over several ticks, so a
   *  fixed number of microtask flushes is racy. */
  async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start <= timeout) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** A memory router carrying `/admin/$section`, so the section links are the
   *  real `<Link>`s an operator clicks rather than stubbed anchors. */
  function buildRouter() {
    const rootRoute = createRootRoute();
    const sectionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/$section",
      component: AdminOverview,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([sectionRoute]),
      history: createMemoryHistory({ initialEntries: ["/admin/overview"] }),
    });
  }

  function render(): Promise<void> {
    const router = buildRouter();
    return act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          createElement(RouterProvider as any, { router }) as ReactNode,
        ),
      );
      return Promise.resolve();
    });
  }

  /** Waits for every card to stop reading "Checking…". The checks are released
   *  one at a time to stay inside the org's request budget, so the last one
   *  answers about a second after the first — waiting on a single card would
   *  assert against a half-loaded page. */
  async function renderWorkspace(workspace: Workspace, settled = true): Promise<void> {
    mockWorkspace(workspace);
    await render();
    if (settled) {
      await waitFor(() => {
        expect(stillChecking()).toEqual([]);
      }, 6000);
    }
  }

  function stillChecking(): readonly string[] {
    return cardTitles().filter((title) => chipFor(title) === "Checking…");
  }

  function text(): string {
    return container.textContent ?? "";
  }

  /** Check cards only (not enterprise detail bands). */
  function checkSections(): readonly HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('section[data-overview-band="check"]')];
  }

  /** Every check card is a `<section>` labelled by its own `<h3>`. Detail bands
   *  use the same shape but a different data attribute so helpers stay honest. */
  function card(title: string): HTMLElement {
    const match = [
      ...checkSections(),
      ...container.querySelectorAll<HTMLElement>('section[data-overview-band="detail"]'),
    ].find((section) => section.querySelector("h3")?.textContent?.trim() === title);
    if (!match) {
      throw new Error(`Card "${title}" not found. Cards: ${cardTitles().join(" | ")}`);
    }
    return match;
  }

  function cardTitles(): readonly string[] {
    return checkSections().map((section) => section.querySelector("h3")?.textContent?.trim() ?? "");
  }

  function chipFor(title: string): string {
    return card(title).querySelector(".chip")?.textContent?.trim() ?? "";
  }

  /** The big number and its caption, e.g. `1/2 domains verified`. Joined with
   *  a space because the gap between them is CSS, not a text node. */
  function figureFor(title: string): string {
    const figure = card(title).querySelector("p");
    if (!figure) {
      throw new Error(`Card "${title}" has no figure`);
    }
    return [...figure.querySelectorAll("span")]
      .map((span) => span.textContent?.trim() ?? "")
      .join(" ");
  }

  function cardText(title: string): string {
    return card(title).textContent ?? "";
  }

  /** The page-width failure banner for one check, found by the summary line it
   *  leads with. */
  function failureBanner(title: string): HTMLElement {
    const match = [...container.querySelectorAll<HTMLElement>('[role="alert"]')].find((alert) =>
      alert.textContent?.includes(`${title} could not be read`),
    );
    if (!match) {
      throw new Error(`No failure banner for "${title}"`);
    }
    return match;
  }

  /** The attention band's headline, or null when the band is not in its
   *  attention state. */
  function attentionHeading(): string | null {
    return container.querySelector("#admin-overview-attention")?.textContent?.trim() ?? null;
  }

  /** The clean-bill-of-health headline. Its presence is the page's only
   *  workspace-wide positive claim, so tests assert on this element rather
   *  than on the phrase, which also appears in the scoped partial reading. */
  function cleanHeading(): string | null {
    return container.querySelector("#admin-overview-clear")?.textContent?.trim() ?? null;
  }

  function linkHrefs(scope: ParentNode = container): readonly string[] {
    return [...scope.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href") ?? "");
  }

  /** The sentence each card says the headline counted from it, in card order. */
  function countedAbove(): readonly string[] {
    return [...container.querySelectorAll("section p")]
      .map((paragraph) => paragraph.textContent?.trim() ?? "")
      .filter((line) => line.startsWith("Counted above:"))
      .map((line) => line.slice("Counted above:".length).trim());
  }

  /** The sentences the attention band actually counted, in band order. */
  function bandItems(): readonly string[] {
    const band = container.querySelector("#admin-overview-attention")?.closest("section");
    return [...(band?.querySelectorAll("li > span") ?? [])].map(
      (item) => item.textContent?.trim() ?? "",
    );
  }

  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const match = [...scope.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!match) {
      throw new Error(`Button "${label}" not found`);
    }
    return match;
  }

  function click(element: HTMLElement): Promise<void> {
    return act(() => {
      element.click();
      return Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /* ---------------------------------------------------------------- */
  /* Real figures                                                      */
  /* ---------------------------------------------------------------- */

  it("renders the real figure behind every check", async () => {
    await renderWorkspace({
      domains: {
        domains: [
          domainEntry("helix.local", "verified", true),
          domainEntry("mail.helix.local", "verified"),
        ],
      },
      policies: {
        policies: [
          policy("mfa", true, "required"),
          policy("sso", true, "optional"),
          policy("dlp", false, "disabled"),
        ],
      },
      platform: {
        config: {
          security: { tier: "enterprise" },
          ai: {
            operatorLlm: {
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-4o-mini",
              apiKeyConfigured: true,
            },
            mailSpamAi: { betaEnabled: true },
          },
        },
        readiness: { ready: true, requirements: [] },
      },
      users: {
        users: [user("u-1"), user("u-2"), user("u-3", "2026-05-01T00:00:00Z")],
        nextCursor: null,
      },
      coreApps: {
        role: "all",
        apps: [coreApp("mail", "Mail", true), coreApp("chat", "Chat", false)],
      },
    });

    expect(figureFor("Domains")).toBe("2/2 domains verified");
    // 1 of 3 policies is both enabled AND required — the other two are not.
    expect(figureFor("Security policies")).toBe("1/3 policies enforced");
    expect(figureFor("Tier readiness")).toBe("Enterprise security tier");
    expect(figureFor("Directory")).toBe("3 accounts");
    expect(figureFor("Workspace apps")).toBe("1/2 apps enabled");

    // The counts an operator acts on, not just the headline number.
    expect(cardText("Directory")).toContain("1 suspended, 2 active");
    expect(cardText("Workspace apps")).toContain("Off: Chat");
    expect(cardText("Security policies")).toContain(
      "Not runtime-enforced: Single sign-on (SSO), DLP — Data loss prevention",
    );

    // Enterprise detail bands — same payloads, richer operational surface.
    expect(text()).toContain("Operational detail");
    expect(cardText("Security & tier")).toContain("Enterprise");
    expect(cardText("Security & tier")).toContain("Ready");
    expect(cardText("People & domains")).toContain("2/2 verified");
    expect(cardText("People & domains")).toContain("2 active, 1 suspended");
    expect(cardText("App enablement")).toContain("Mail");
    expect(cardText("AI & mail spam")).toContain("Stored in Admin");
    expect(cardText("AI & mail spam")).toContain("Enabled (beta)");
    expect(cardText("AI & mail spam")).toContain("gpt-4o-mini");
    expect(text()).not.toContain("sk-");
  });

  it("marks the directory count as a floor when the API pages", async () => {
    await renderWorkspace({
      ...CLEAN,
      users: { users: [user("u-1"), user("u-2")], nextCursor: "cursor-2" },
    });

    // Not "2": there is a next page, so 2 is the least it can be.
    expect(figureFor("Directory")).toBe("2+ accounts (first page)");
  });

  /* ---------------------------------------------------------------- */
  /* Leading with what needs attention                                 */
  /* ---------------------------------------------------------------- */

  it("leads with the unverified domain and links to the section that fixes it", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: {
        domains: [
          domainEntry("helix.local", "verified", true),
          domainEntry("mail.helix.local", "pending"),
        ],
      },
    });

    expect(attentionHeading()).toBe("1 thing needs attention");
    expect(text()).toContain("1 of 2 domains is not verified");
    expect(cleanHeading()).toBeNull();

    expect(chipFor("Domains")).toBe("Needs attention");
    expect(cardText("Domains")).toContain("0 failed, 1 pending verification");

    const band = container.querySelector("#admin-overview-attention")?.closest("section");
    expect(band).not.toBeNull();
    expect(linkHrefs(band as HTMLElement)).toContain("/admin/domains");
  });

  it("counts every rule that fired, not just the first", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: { domains: [domainEntry("helix.local", "failed", true)] },
      platform: {
        config: { security: { tier: "business" } },
        readiness: {
          ready: false,
          requirements: [
            {
              key: "kms",
              label: "KMS",
              required: true,
              status: "missing",
              expected: {},
              observed: {},
            },
          ],
        },
      },
    });

    expect(attentionHeading()).toBe("2 things need attention");
    expect(text()).toContain("1 of 1 domain is not verified");
    expect(text()).toContain("The Business tier is not ready");
    expect(cardText("Tier readiness")).toContain("1 requirement is missing or degraded");
  });

  it("says a clean workspace is clean rather than showing an empty page", async () => {
    await renderWorkspace(CLEAN);

    expect(cleanHeading()).toBe("Nothing needs attention");
    expect(text()).toContain("All 5 checks responded and none of them is flagging a problem");
    expect(attentionHeading()).toBeNull();
    // A clean workspace still shows its numbers — this is a status surface,
    // not an empty state.
    expect(figureFor("Domains")).toBe("1/1 domain verified");
  });

  /* ---------------------------------------------------------------- */
  /* The page's own request budget                                     */
  /* ---------------------------------------------------------------- */

  it("reads the whole page in one request", async () => {
    const requested: string[] = [];
    fetchMock.mockImplementation((input) => {
      requested.push(requestUrl(input));
      return overviewEnvelope(CLEAN).then((body) => Response.json(body));
    });
    await render();

    await waitFor(() => {
      expect(stillChecking()).toEqual([]);
    }, 6000);

    /* The original defect: five checks leaving in the same tick overran the
       tenant's 5 rps quota and one came back 429 — on the page whose job is to
       report on the workspace's health. The client answer was a release queue
       that spread them over a second; the real answer is not to make five
       requests. Anything above one here means a section is back to reading its
       own endpoint and the pacing problem is back with it. */
    expect(requested).toEqual(["/api/admin/overview"]);
  });

  it("treats a 429 as ask-again-later rather than a verdict", async () => {
    let attempts = 0;
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/admin/overview")) {
        attempts += 1;
        if (attempts === 1) {
          // The shape the limiter actually sends: a nested envelope, so the
          // client falls back to its generated "(429)." message.
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "quota.api_rps.exceeded",
                  message: "Tenant API request rate limit exceeded.",
                  traceId: "trace-1",
                },
              },
              { status: 429 },
            ),
          );
        }
      }
      return overviewEnvelope(CLEAN).then((body) => Response.json(body));
    });

    await render();

    await waitFor(() => {
      expect(attempts).toBe(1);
    }, 6000);
    /* The page reads one request, so a refusal holds every card rather than one
       — but the invariant is unchanged and is the point of the test: while a
       retry is pending nothing claims a verdict. Cards read as checking, the
       headline withholds "nothing needs attention", and Refresh stays disabled
       rather than inviting a second burst into the same limit. */
    expect(stillChecking().length).toBeGreaterThan(0);
    expect(cleanHeading()).toBeNull();
    expect(button("Refreshing…").disabled).toBe(true);

    await waitFor(() => {
      expect(chipFor("Workspace apps")).toBe("Nothing flagged");
    }, 8000);

    expect(attempts).toBe(2);
    expect(figureFor("Workspace apps")).toBe("1/1 app enabled");
    // The regression: `retry: false` made a rate limit permanent, so the front
    // door greeted the operator with a red band about a limit it had tripped
    // itself. Nothing may be reported as unreadable while a retry is pending.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain("could not be read");
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  it("still reports a status that retrying cannot fix", async () => {
    let attempts = 0;
    fetchMock.mockImplementation(() => {
      attempts += 1;
      return overviewEnvelope({ ...CLEAN, policies: Response.json({}, { status: 500 }) }).then(
        (body) => Response.json(body),
      );
    });

    await render();
    await waitFor(() => {
      expect(chipFor("Security policies")).toBe("Unavailable");
    }, 6000);

    // Only 429 means "ask again later". Retrying a 500 would hide a real fault
    // behind a spinner, so it is asked once and reported.
    expect(attempts).toBe(1);
    expect(failureBanner("Security policies").textContent).toContain("HTTP 500");
  });

  /* ---------------------------------------------------------------- */
  /* Never a healthy zero                                              */
  /* ---------------------------------------------------------------- */

  it("does not render a refused request as a healthy zero", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: Response.json({ error: "Domain admin permission denied." }, { status: 403 }),
    });

    await waitFor(() => {
      expect(chipFor("Domains")).toBe("Unavailable");
    });

    // The regression this whole section is built to avoid: a 403 arriving as
    // "0/0 domains verified" — or worse, as a green "nothing flagged".
    expect(figureFor("Domains")).toBe("— not read");
    expect(cardText("Domains")).not.toContain("verified");
    // The card says it is unavailable and routes to the full reason, which is
    // rendered at page width because a cause sentence plus a raw backend
    // message does not fit a card column.
    expect(cardText("Domains")).toContain("banner above");
    // `describeFailure` only reads a status off the message tail, and the
    // backend sent its own `error` string instead — so the honest cause here
    // is the generic one, not a guessed 403 sentence. The raw message is what
    // support gets to work with.
    expect(failureBanner("Domains").textContent).toContain(
      "did not return a usable response for domains",
    );
    expect(failureBanner("Domains").textContent).toContain("Domain admin permission denied.");
    // Above the grid, so it is read before the cards it explains.
    expect(
      failureBanner("Domains").compareDocumentPosition(card("Domains")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // And the page-level claim is withdrawn: no clean bill of health.
    expect(cleanHeading()).toBeNull();
    expect(text()).toContain("Nothing needs attention in the 4 of 5 checks that responded");
    expect(text()).toContain("1 check is unavailable");
    expect(text()).toContain("This is not a clean bill of health");
  });

  it("keeps the four checks that answered when one query dies", async () => {
    await renderWorkspace({
      ...CLEAN,
      users: { users: [user("u-1"), user("u-2"), user("u-3")], nextCursor: null },
      policies: Response.json({}, { status: 500 }),
    });

    await waitFor(() => {
      expect(chipFor("Security policies")).toBe("Unavailable");
    });

    // One dead query must not blank the page.
    expect(figureFor("Directory")).toBe("3 accounts");
    expect(figureFor("Domains")).toBe("1/1 domain verified");
    expect(cardTitles()).toHaveLength(5);
    // With no backend `error` string the status survives in the message tail,
    // so the banner can name it instead of guessing a cause.
    expect(failureBanner("Security policies").textContent).toContain("HTTP 500");
  });

  it("reports a failure beside an attention item without absorbing it", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: { domains: [domainEntry("helix.local", "failed", true)] },
      coreApps: Response.json({ error: "Core apps unavailable." }, { status: 503 }),
    });

    await waitFor(() => {
      expect(chipFor("Workspace apps")).toBe("Unavailable");
    });

    expect(attentionHeading()).toBe("1 thing needs attention");
    // The band must not imply the list is exhaustive while a check is blind.
    expect(text()).toContain("1 check is unavailable");
    expect(text()).toContain("not the whole workspace");
  });

  it("retries a dead check from its failure banner", async () => {
    await renderWorkspace({
      ...CLEAN,
      coreApps: Response.json({ error: "Core apps unavailable." }, { status: 503 }),
    });
    await waitFor(() => {
      expect(chipFor("Workspace apps")).toBe("Unavailable");
    });

    mockWorkspace(CLEAN);
    await click(button("Retry", failureBanner("Workspace apps")));

    await waitFor(() => {
      expect(chipFor("Workspace apps")).toBe("Nothing flagged");
    });
    expect(figureFor("Workspace apps")).toBe("1/1 app enabled");
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  it("does not claim a clean workspace while the checks are still loading", async () => {
    // No endpoint ever answers, so every query stays pending.
    await renderWorkspace({}, false);

    expect(cleanHeading()).toBeNull();
    expect(attentionHeading()).toBeNull();
    expect(text()).toContain("Checking domains, security policies, tier readiness");
    for (const title of ["Domains", "Security policies", "Directory"]) {
      expect(chipFor(title)).toBe("Checking…");
      expect(figureFor(title)).toBe("— reading…");
    }
  });

  /* ---------------------------------------------------------------- */
  /* Unknown is not "off"                                              */
  /* ---------------------------------------------------------------- */

  it("treats an absent MFA record as unknown rather than unenforced", async () => {
    await renderWorkspace({
      ...CLEAN,
      policies: { policies: [policy("external_sharing", true, "required")] },
    });

    // No `mfa` record came back. Reporting "Multi-factor authentication is not
    // enforced" would be inventing a policy state the backend never sent.
    expect(text()).not.toContain("Multi-factor authentication is not enforced");
    expect(figureFor("Security policies")).toBe("1/1 policy enforced");
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  it("does not count recorded-only DLP required intent as enforced", async () => {
    await renderWorkspace({
      ...CLEAN,
      policies: { policies: [policy("dlp", true, "required"), policy("mfa", true, "required")] },
    });

    expect(figureFor("Security policies")).toBe("1/2 policies enforced");
    expect(cardText("Security policies")).toContain("DLP");
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  it("escalates MFA only when the record says it is not enforced", async () => {
    await renderWorkspace({
      ...CLEAN,
      policies: { policies: [policy("mfa", true, "optional")] },
    });

    expect(attentionHeading()).toBe("1 thing needs attention");
    expect(text()).toContain("Multi-factor authentication is not enforced");
    expect(chipFor("Security policies")).toBe("Needs attention");
  });

  it("flags an empty workspace instead of reading it as configured", async () => {
    await renderWorkspace({
      domains: { domains: [] },
      policies: { policies: [] },
      platform: {
        config: { security: { tier: "personal" } },
        readiness: { ready: true, requirements: [] },
      },
      users: { users: [], nextCursor: null },
      coreApps: { role: "all", apps: [] },
    });

    expect(attentionHeading()).toBe("4 things need attention");
    expect(text()).toContain("No domains are registered.");
    expect(text()).toContain("No security policies are configured.");
    expect(text()).toContain("The directory has no accounts.");
    expect(text()).toContain("No workspace apps were returned.");
  });

  /* ---------------------------------------------------------------- */
  /* The headline and the cards must agree                             */
  /* ---------------------------------------------------------------- */

  it("counts on each card exactly what the headline counted from it", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: { domains: [domainEntry("helix.local", "failed", true)] },
      policies: {
        policies: [
          policy("mfa", false, "disabled"),
          policy("sso", false, "disabled"),
          policy("session", false, "disabled"),
          policy("external_sharing", false, "disabled"),
          policy("dlp", false, "disabled"),
          policy("device_trust", false, "disabled"),
        ],
      },
    });

    // The mismatch this guards: "2 things need attention" over a card reading
    // 0/6 enforced and naming six unenforced policies.
    expect(attentionHeading()).toBe("2 things need attention");
    expect(figureFor("Security policies")).toBe("0/6 policies enforced");
    expect(cardText("Security policies")).toContain(
      "Only an unenforced multi-factor policy is counted above",
    );

    // Structural, not prose: every sentence the band counted appears on the
    // card it came from, and no card claims a finding the band did not count.
    expect(countedAbove()).toEqual(bandItems());
    expect(countedAbove()).toEqual([
      "1 of 1 domain is not verified.",
      "Multi-factor authentication is not enforced.",
    ]);
  });

  it("claims nothing on a card the headline did not count", async () => {
    await renderWorkspace({
      ...CLEAN,
      coreApps: {
        role: "all",
        apps: [coreApp("mail", "Mail", true), coreApp("chat", "Chat", false)],
      },
    });

    // The apps card lists a disabled app but escalates nothing, so it must not
    // show a counted line — the chip is what says the rule stayed silent.
    expect(cardText("Workspace apps")).toContain("Off: Chat");
    expect(chipFor("Workspace apps")).toBe("Nothing flagged");
    expect(countedAbove()).toEqual([]);
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  /* ---------------------------------------------------------------- */
  /* What the page cannot see                                          */
  /* ---------------------------------------------------------------- */

  it("says how much of the console it does not check, even when clean", async () => {
    await renderWorkspace(CLEAN);

    // A clean Overview is the reading an operator over-trusts, so the coverage
    // sentence has to be there in exactly that state. Total section count is
    // derived from ADMIN_SECTION_IDS (grows when Chat/Drive admin land).
    expect(cleanHeading()).toBe("Nothing needs attention");
    expect(text()).toMatch(/These checks read 5 of the console's \d+ sections/);
    expect(text()).toMatch(/The other \d+ are not read here at all/);
    expect(text()).toContain("A quiet Overview is not a checked workspace");
  });

  it("names the sections no check reads", async () => {
    await renderWorkspace(CLEAN);

    const details = container.querySelector<HTMLDetailsElement>("details.admin-disclosure");
    // Billing is the worked example: the whole section 404s and no check here
    // can see it.
    expect(details?.textContent).toContain("Billing & usage");
    expect(details?.textContent).toContain("Audit log");
    // The checked sections must not appear in the not-read list.
    expect(details?.textContent).not.toContain("No check on this page reads Domains");
  });

  it("keeps the coverage sentence while a check is unavailable", async () => {
    await renderWorkspace({
      ...CLEAN,
      domains: Response.json({ error: "Domain admin permission denied." }, { status: 403 }),
    });

    await waitFor(() => {
      expect(chipFor("Domains")).toBe("Unavailable");
    });
    // Two different gaps — the check that broke, and the remaining sections
    // nothing here ever looks at. Neither may stand in for the other.
    expect(text()).toContain("1 check is unavailable");
    expect(text()).toMatch(/These checks read 5 of the console's \d+ sections/);
  });

  /* ---------------------------------------------------------------- */
  /* Navigation and controls                                           */
  /* ---------------------------------------------------------------- */

  it("routes every figure to the section that acts on it", async () => {
    await renderWorkspace(CLEAN);

    expect(linkHrefs(card("Domains"))).toEqual(["/admin/domains"]);
    expect(linkHrefs(card("Security policies"))).toEqual(["/admin/policies"]);
    expect(linkHrefs(card("Tier readiness"))).toEqual(["/admin/tier-readiness"]);
    expect(linkHrefs(card("Directory"))).toEqual(["/admin/users"]);
    expect(linkHrefs(card("Workspace apps"))).toEqual(["/admin/workspace-apps"]);
  });

  it("refetches every check from the header control", async () => {
    await renderWorkspace(CLEAN);
    const before = fetchMock.mock.calls.length;

    await click(button("Refresh"));
    await waitFor(() => {
      /* One request refreshes every card now — the five it replaced are what
         made this page trip the tenant's rate limit in the first place. */
      expect(fetchMock.mock.calls.length).toBe(before + 1);
    });
  });

  it("keeps the derivation notes closed by default", async () => {
    await renderWorkspace(CLEAN);

    const details = container.querySelector<HTMLDetailsElement>("details.admin-disclosure");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    // Nothing needed for the primary task may hide in here.
    expect(details?.querySelector("summary")?.textContent).toContain("Where these five figures");
  });

  it("starts the heading hierarchy at h1 and skips no level", async () => {
    await renderWorkspace(CLEAN);

    const levels = [...container.querySelectorAll("h1, h2, h3")].map((element) =>
      Number(element.tagName.slice(1)),
    );
    expect(levels[0]).toBe(1);
    for (const [index, level] of levels.entries()) {
      const previous = levels[index - 1] ?? level;
      expect(level - previous).toBeLessThanOrEqual(1);
    }
  });
});

describe("prefetchAdminOverviewQueries", () => {
  /* The route loader hands this helper an `ensureQueryData` and nothing else,
     so the whole contract is observable from a stub. */
  function ensureQueryDataMock() {
    return vi.fn<(options: { readonly queryKey: readonly unknown[] }) => Promise<unknown>>();
  }

  it("warms the whole page in one request", async () => {
    const ensureQueryData = ensureQueryDataMock().mockResolvedValue(undefined);

    await prefetchAdminOverviewQueries({ ensureQueryData });

    /* Bounded on purpose, and the bound is one — measured, not reasoned.
       The tenant ceiling is 5 requests/second and a real cold load shows the
       app shell spending 3 of them (`SHELL_BASELINE_REQUESTS`: /api/core-apps,
       notifications.unread-count, notifications.list) inside the same 20 ms.
       With two checks prefetched, both landed in that window and one came back
       429 — it recovered, because the 429-only retry makes a refusal survivable
       rather than permanent, but a card that arrives 1.4 s late having been
       refused is worse than one that waited its turn.
       Letting this grow back silently rebuilds that burst one layer above where
       the release schedule can reach it. */
    expect(ensureQueryData).toHaveBeenCalledTimes(1);
    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([
      adminOverviewQueryKey,
    ]);
  });

  it("resolves even when a warmed query rejects, so a dead check cannot blank the route", async () => {
    const ensureQueryData = ensureQueryDataMock().mockRejectedValue(
      new Error("domains unavailable"),
    );

    await expect(prefetchAdminOverviewQueries({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });
});
