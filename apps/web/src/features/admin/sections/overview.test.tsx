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
import { AdminOverview } from "@/features/admin/sections/overview";

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
    policies: [policy("mfa", true, "required"), policy("dlp", true, "required")],
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

  /** Routes each admin endpoint to its own payload. A `Response` is served as
   *  given (so a test can hand back a 403), anything else is wrapped as 200
   *  JSON, and `undefined` means "never answers" — the pending state. */
  function mockWorkspace(workspace: Workspace) {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      const payload = payloadFor(url, workspace);
      if (payload === undefined) {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(payload instanceof Response ? payload : Response.json(payload));
    });
  }

  function payloadFor(url: string, workspace: Workspace): unknown {
    if (url.includes("/api/admin/domains")) {
      return workspace.domains;
    }
    if (url.includes("/api/admin/security-policies")) {
      return workspace.policies;
    }
    if (url.includes("/api/admin/platform-config")) {
      return workspace.platform;
    }
    if (url.includes("/api/admin/core-apps")) {
      return workspace.coreApps;
    }
    if (url.includes("/api/admin/users")) {
      return workspace.users;
    }
    throw new Error(`Unexpected request in AdminOverview: ${url}`);
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

  /** Every card is a `<section>` labelled by its own `<h3>`. */
  function card(title: string): HTMLElement {
    const match = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h3")?.textContent?.trim() === title,
    );
    if (!match) {
      throw new Error(`Card "${title}" not found. Cards: ${cardTitles().join(" | ")}`);
    }
    return match;
  }

  function cardTitles(): readonly string[] {
    return [...container.querySelectorAll("section h3")].map((h3) => h3.textContent?.trim() ?? "");
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
        config: { security: { tier: "enterprise" } },
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
      "Not required: Single sign-on (SSO), DLP — Data loss prevention",
    );
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

  it("does not spend the org's whole per-second request budget in one tick", async () => {
    const startedAt: number[] = [];
    fetchMock.mockImplementation((input) => {
      startedAt.push(Date.now());
      const payload = payloadFor(requestUrl(input), CLEAN);
      return Promise.resolve(payload instanceof Response ? payload : Response.json(payload));
    });
    await render();

    // The defect: five checks leaving in the same tick, on top of whatever the
    // shell is fetching, overran the tenant's 5 rps quota and one came back 429.
    expect(startedAt).toHaveLength(1);

    await waitFor(() => {
      expect(stillChecking()).toEqual([]);
    }, 6000);

    // Paced, not dropped — every check still runs …
    expect(startedAt).toHaveLength(5);
    // … and they span more than the limiter's one-second window, so no single
    // second of the org's budget carries all five.
    const span = Number(startedAt.at(-1)) - Number(startedAt.at(0));
    expect(span).toBeGreaterThanOrEqual(750);
  });

  it("treats a 429 as ask-again-later rather than a verdict", async () => {
    let coreAppAttempts = 0;
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/admin/core-apps")) {
        coreAppAttempts += 1;
        if (coreAppAttempts === 1) {
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
      const payload = payloadFor(url, CLEAN);
      return Promise.resolve(payload instanceof Response ? payload : Response.json(payload));
    });

    await render();

    await waitFor(() => {
      expect(coreAppAttempts).toBe(1);
      expect(stillChecking()).toEqual(["Workspace apps"]);
    }, 6000);
    // A check waiting out the limiter is still in flight: it reads as checking,
    // not as a verdict, and Refresh stays disabled rather than inviting the
    // operator to fire a second burst into the same limit.
    expect(cleanHeading()).toBeNull();
    expect(button("Refreshing…").disabled).toBe(true);

    await waitFor(() => {
      expect(chipFor("Workspace apps")).toBe("Nothing flagged");
    }, 8000);

    expect(coreAppAttempts).toBe(2);
    expect(figureFor("Workspace apps")).toBe("1/1 app enabled");
    // The regression: `retry: false` made a rate limit permanent, so the front
    // door greeted the operator with a red band about a limit it had tripped
    // itself. Nothing may be reported as unreadable while a retry is pending.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain("could not be read");
    expect(cleanHeading()).toBe("Nothing needs attention");
  });

  it("still reports a status that retrying cannot fix", async () => {
    let policyAttempts = 0;
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/admin/security-policies")) {
        policyAttempts += 1;
        return Promise.resolve(Response.json({}, { status: 500 }));
      }
      const payload = payloadFor(url, CLEAN);
      return Promise.resolve(payload instanceof Response ? payload : Response.json(payload));
    });

    await render();
    await waitFor(() => {
      expect(chipFor("Security policies")).toBe("Unavailable");
    }, 6000);

    // Only 429 means "ask again later". Retrying a 500 would hide a real fault
    // behind a spinner, so it is asked once and reported.
    expect(policyAttempts).toBe(1);
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
      policies: { policies: [policy("dlp", true, "required")] },
    });

    // No `mfa` record came back. Reporting "Multi-factor authentication is not
    // enforced" would be inventing a policy state the backend never sent.
    expect(text()).not.toContain("Multi-factor authentication is not enforced");
    expect(figureFor("Security policies")).toBe("1/1 policy enforced");
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
    // sentence has to be there in exactly that state.
    expect(cleanHeading()).toBe("Nothing needs attention");
    expect(text()).toContain("These checks read 5 of the console's 18 sections");
    expect(text()).toContain("The other 13 are not read here at all");
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
    // Two different gaps — the check that broke, and the fourteen sections
    // nothing here ever looks at. Neither may stand in for the other.
    expect(text()).toContain("1 check is unavailable");
    expect(text()).toContain("These checks read 5 of the console's 18 sections");
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
      expect(fetchMock.mock.calls.length).toBe(before + 5);
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
