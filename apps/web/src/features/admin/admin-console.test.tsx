// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { AdminConsole } from "./admin-console";
import type { AdminSectionId } from "./admin-console-data";

/** TopBar calls `sessionUserQueryOptions()` → fetch("/api/auth/get-session").
 * That would consume the per-test fetchMock Response before the AdminUsers
 * query reads it, so we stub the session query to a resolved null instead. */
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    sessionUserQueryOptions: () => ({
      queryKey: ["auth", "session"],
      queryFn: () => Promise.resolve(null),
      staleTime: 30_000,
      throwOnError: false,
    }),
  };
});

/* The console now mounts inside a real (memory) router, so `useRouter` needs
 * no stub — it resolves against the test router built in `buildRouter`. */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

const apiUsers = {
  users: [
    {
      id: "u-1",
      orgId: "org-1",
      type: "human",
      email: "mira@helix.io",
      displayName: "Mira Okafor",
      scopes: ["admin"],
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "u-2",
      orgId: "org-1",
      type: "human",
      email: "marcus@helix.io",
      displayName: "Marcus Bell",
      scopes: [],
      disabledAt: "2026-05-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ],
  nextCursor: null,
};

const apiBillingAccount = {
  account: {
    orgId: "org-1",
    planName: "Business Plus",
    pricePerSeatCents: 2900,
    billingCycle: "monthly",
    currency: "USD",
    licensesTotal: 20,
    licensesUsed: 12,
    storageUsedBytes: 120_000_000_000,
    storageLimitBytes: 1_000_000_000_000,
    aiCreditsUsed: 500,
    aiCreditsLimit: 1000,
    nextInvoiceCents: 34_800,
    nextInvoiceAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
  meters: [
    { id: "licenses", used: 12, limit: 20, fraction: 0.6 },
    { id: "storage", used: 120_000_000_000, limit: 1_000_000_000_000, fraction: 0.12 },
    { id: "ai_credits", used: 500, limit: 1000, fraction: 0.5 },
  ],
};

const apiInvoices = {
  invoices: [
    {
      id: "inv-1",
      orgId: "org-1",
      invoiceNumber: "INV-001",
      amountCents: 34_800,
      currency: "USD",
      status: "paid",
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
      issuedAt: "2026-05-01T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ],
  nextCursor: null,
};

const apiUsageRollups = {
  rollups: [
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "ai_tokens",
      quantity: 1234,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "storage_avg_bytes",
      quantity: 2_048_000,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "seats_max",
      quantity: 12,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
  ],
  summary: {
    periodStart: "2026-05-23",
    periodEnd: "2026-05-24",
    metrics: [
      { metricKey: "ai_tokens", quantity: 1234, aggregation: "sum", sampleCount: 1 },
      {
        metricKey: "storage_avg_bytes",
        quantity: 2_048_000,
        aggregation: "average",
        sampleCount: 1,
      },
      { metricKey: "seats_max", quantity: 12, aggregation: "max", sampleCount: 1 },
    ],
  },
};

const apiSecurityPolicies = {
  policies: [
    securityPolicy("mfa", {
      allowedMethods: ["hardware_key", "totp"],
      rememberDeviceDays: 0,
    }),
    securityPolicy("sso", {
      provider: "google",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
      jitProvisioning: true,
      mappedDomains: ["helix.local"],
      localLoginEnabled: true,
      setupStatus: "draft",
      testLoginStatus: "runtime_pending",
      setupSource: "admin",
    }),
    securityPolicy("session", {
      inactivityTimeoutDays: 14,
      reauthForAdminActions: true,
      maxConcurrentSessions: 10,
    }),
    securityPolicy("external_sharing", {
      mode: "allowlist",
      allowedDomains: ["helix.local"],
      requireExpiry: true,
    }),
    securityPolicy("dlp", {
      detectors: ["ssn"],
      action: "warn",
    }),
    securityPolicy("device_trust", {
      protectedApps: ["admin"],
    }),
  ],
};

/** Set a React-controlled input's value via the native prototype setter so
 *  the synthetic `input` event reflects the new value. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(
    select,
    value,
  );
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
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

function mockJsonResponse(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  payload: unknown,
): void {
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(payload)));
}

/** localStorage key the sidebar stores its folded nav groups under. */
const COLLAPSED_GROUPS_KEY = "helix.admin.nav.collapsed-groups";

/** A Map-backed `localStorage` for the tests that exercise a *persisted*
 *  preference. The suite's default stub always reads back `null`, which cannot
 *  tell "the sidebar kept the operator's choice" from "the sidebar reset and
 *  re-read an empty store". Replaced again by the next `beforeEach`. */
function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  return store;
}

/** jsdom does no layout, so every scroll metric is 0 and the nav can never
 *  report overflow on its own. Stub the three numbers the affordance reads. */
function stubScrollGeometry(
  element: HTMLElement,
  geometry: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

function mockAdminBillingResponses(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock.mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
    if (url.includes("/api/admin/billing/account")) {
      return Promise.resolve(Response.json(apiBillingAccount));
    }
    if (url.includes("/api/admin/billing/invoices")) {
      return Promise.resolve(Response.json(apiInvoices));
    }
    if (url.includes("/api/admin/billing/usage")) {
      return Promise.resolve(Response.json(apiUsageRollups));
    }
    return Promise.resolve(Response.json(apiUsers));
  });
}

/** Every billing endpoint fails with the same status — the shape of a billing
 *  service that is down, which is what the page-level failure state is for. */
function mockAdminBillingFailure(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  status: number,
): void {
  fetchMock.mockImplementation((input) => {
    const url = requestUrl(input);
    if (url.includes("/api/admin/billing/")) {
      return Promise.resolve(Response.json({}, { status }));
    }
    return Promise.resolve(Response.json(apiUsers));
  });
}

function mockAdminSecurityResponses(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock.mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
    if (url.includes("/api/admin/security-policies")) {
      return Promise.resolve(Response.json(apiSecurityPolicies));
    }
    return Promise.resolve(Response.json(apiUsers));
  });
}

function securityPolicy(policyType: string, settings: Record<string, unknown>) {
  return {
    id: `policy-${policyType}`,
    orgId: "org-1",
    policyType,
    enabled: true,
    enforcement: "optional",
    settings,
    updatedBy: "u-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("AdminConsole", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  let router: ReturnType<typeof buildRouter>;

  /** A memory router carrying just `/admin/$section`.
   *  The console reads its section from the route, and the sidebar navigates
   *  with real `<Link>`s, so these tests exercise the actual URL behaviour
   *  rather than a stubbed navigation callback. */
  function buildRouter(section: AdminSectionId) {
    const rootRoute = createRootRoute();
    const sectionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/$section",
      component: function AdminSectionRoute() {
        // `strict: false` because this ad-hoc tree isn't the generated one.
        // The section still types as `AdminSectionId` — the real route's
        // `params.parse` is what the registered router types resolve to.
        const params = useParams({ strict: false });
        return createElement(AdminConsole, { section: params.section ?? "overview" });
      },
    });
    return createRouter({
      routeTree: rootRoute.addChildren([sectionRoute]),
      history: createMemoryHistory({ initialEntries: [`/admin/${section}`] }),
    });
  }

  /* Sections are lazy-loaded chunks, so the panel is a Suspense fallback for a
     tick after the router mounts. Callers assert on section content, so this
     settles the chunk before returning rather than making every test wrap its
     first assertion in `waitFor`. */
  async function renderConsole(section: AdminSectionId = "overview"): Promise<void> {
    await renderRouter(section);
    await waitFor(() => {
      expect(container.querySelector("h1")).not.toBeNull();
    });
  }

  function renderRouter(section: AdminSectionId): Promise<void> {
    router = buildRouter(section);
    return act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            ShellOverlayContext.Provider,
            { value: overlayApi },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createElement(RouterProvider as any, { router }),
          ),
        ),
      );
      return Promise.resolve();
    });
  }

  /** Click a sidebar entry by its visible label. */
  function clickNav(label: string): Promise<void> {
    const link = [...container.querySelectorAll("a.admin-nav-link")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!link) {
      throw new Error(`Sidebar link "${label}" not found`);
    }
    return act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      return Promise.resolve();
    });
  }

  /** The path the memory router is currently on. */
  function currentPath(): string {
    return router.state.location.pathname;
  }

  /** One sidebar group, found by its heading text. */
  function navGroup(title: string): HTMLElement {
    const label = [...container.querySelectorAll(".admin-nav-group-label")].find(
      (element) => element.textContent?.trim() === title,
    );
    const group = label?.closest(".admin-nav-group");
    if (!(group instanceof HTMLElement)) {
      throw new Error(`Nav group "${title}" not found`);
    }
    return group;
  }

  /** A group's fold control. Null for the group holding the active section —
   *  that one is never collapsible, so it ships no control at all. */
  function navGroupToggle(title: string): HTMLButtonElement | null {
    return navGroup(title).querySelector<HTMLButtonElement>("button.admin-nav-group-toggle");
  }

  /** The list of sections inside a group. */
  function navGroupList(title: string): HTMLUListElement {
    const list = navGroup(title).querySelector("ul");
    if (!list) {
      throw new Error(`Nav group "${title}" has no section list`);
    }
    return list;
  }

  /** The nav's scroll container. */
  function navElement(): HTMLElement {
    const nav = container.querySelector<HTMLElement>("nav.admin-nav");
    if (!nav) {
      throw new Error("Admin nav not rendered");
    }
    return nav;
  }

  /** A rendered button by its visible label, ignoring any leading icon. */
  function findButton(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!match) {
      throw new Error(`Button "${label}" not found`);
    }
    return match;
  }

  /** `HTMLElement.click()` is a no-op on a disabled control, so this doubles as
   *  the check that a disabled button cannot fire its handler. */
  function clickButton(label: string): Promise<void> {
    const button = findButton(label);
    return act(() => {
      button.click();
      return Promise.resolve();
    });
  }

  /** Error banners rendered inside the admin page body. */
  function pageAlerts(): readonly Element[] {
    return [...container.querySelectorAll('.admin-page [role="alert"]')];
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
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

  it("lands on Overview by default", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole();

    // Overview's own content is covered by sections/overview.test.tsx; this is
    // a routing test, so it asserts only that the default section is the one
    // that rendered.
    expect(container.querySelector("h1")?.textContent).toBe("Workspace overview");
  });

  it("renders the section named in the URL, not a fixed default", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("groups");

    // Deep-linking is the point of the route split: /admin/groups must open
    // Groups without first landing on Overview.
    expect(container.textContent).toContain("Organizational Units");
    expect(container.querySelector("h1")?.textContent).not.toBe("Workspace overview");
  });

  it("groups the sidebar and marks only the active entry", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("domains");

    const groupTitles = [...container.querySelectorAll(".admin-nav-group h2")].map((element) =>
      element.textContent?.trim(),
    );
    expect(groupTitles).toEqual([
      "Organization",
      "People",
      "Security",
      "Apps & integrations",
      "AI",
      "Platform",
    ]);

    const current = [...container.querySelectorAll('a.admin-nav-link[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.trim()).toBe("Domains");
  });

  it("opens every group by default so folding never hides a section on arrival", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("overview");

    // Progressive disclosure buys vertical space, but paying for it with a
    // section the operator has to hunt for is the worse trade. Nothing is
    // folded until someone folds it.
    for (const title of ["Organization", "People", "Security", "Apps & integrations", "AI"]) {
      expect(navGroupList(title).hidden).toBe(false);
      expect(navGroupToggle(title)?.getAttribute("aria-expanded")).toBe("true");
    }
    // No count badges while expanded: the rows themselves are the count.
    expect(container.querySelector(".admin-nav-group-count")).toBeNull();
  });

  it("folds a nav group from its heading and takes the folded rows out of the tab order", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("overview");

    const toggle = navGroupToggle("Apps & integrations");
    const list = navGroupList("Apps & integrations");
    if (!toggle) {
      throw new Error("Expected a fold control on a group that is not the active one");
    }
    // A real <button>, so Enter and Space activate it with no key handler of
    // our own, and it sits in the tab order between the group above and the
    // links it controls.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    expect(list.id).not.toBe("");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    await act(() => {
      toggle.click();
      return Promise.resolve();
    });

    expect(navGroupToggle("Apps & integrations")?.getAttribute("aria-expanded")).toBe("false");
    // `hidden`, not a CSS height collapse — rows nobody can see must not be
    // tab stops.
    expect(navGroupList("Apps & integrations").hidden).toBe(true);
    // Folding must not throw focus away from the control that did it.
    expect(document.activeElement).toBe(navGroupToggle("Apps & integrations"));
    // The summary says what went behind the fold.
    expect(
      navGroup("Apps & integrations").querySelector(".admin-nav-group-count")?.textContent,
    ).toBe("6");
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(["Apps & integrations"]),
    );
  });

  it("folds two groups dispatched in the same React batch without dropping either", async () => {
    const store = installMemoryStorage();
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("overview");

    // Reproduces a real defect: computing the next fold set from the render
    // closure meant both handlers read the same pre-batch snapshot, so the
    // second click overwrote the first and one group silently unfolded.
    await act(() => {
      navGroupToggle("AI")?.click();
      navGroupToggle("Apps & integrations")?.click();
      return Promise.resolve();
    });

    expect(navGroupList("AI").hidden).toBe(true);
    expect(navGroupList("Apps & integrations").hidden).toBe(true);
    // Storage must agree with what is on screen, not with one of the two.
    expect(store.get(COLLAPSED_GROUPS_KEY)).toBe(JSON.stringify(["AI", "Apps & integrations"]));
  });

  it("keeps the group holding the active section open, with no control to fold it", async () => {
    const store = installMemoryStorage();
    // Every group folded, including the one the operator is about to land in.
    store.set(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify([
        "Organization",
        "People",
        "Security",
        "Apps & integrations",
        "AI",
        "Platform",
      ]),
    );
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("audit");

    // Audit log lives in Security. A stored preference may never hide the row
    // the operator is standing on.
    expect(navGroupList("Security").hidden).toBe(false);
    expect(navGroupToggle("Security")).toBeNull();
    expect(navGroup("Security").hasAttribute("data-current")).toBe(true);

    for (const title of ["Organization", "People", "Apps & integrations", "AI", "Platform"]) {
      expect(navGroupList(title).hidden).toBe(true);
      expect(navGroupToggle(title)?.getAttribute("aria-expanded")).toBe("false");
    }

    const current = [...container.querySelectorAll('a.admin-nav-link[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.trim()).toBe("Audit log");
    expect(current[0]?.closest("ul")?.hidden).toBe(false);
  });

  it("keeps a folded group folded across navigation and across a remount", async () => {
    installMemoryStorage();
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("overview");

    const toggle = navGroupToggle("AI");
    await act(() => {
      toggle?.click();
      return Promise.resolve();
    });
    expect(navGroupList("AI").hidden).toBe(true);

    // The console re-renders the sidebar on every section change; a fold that
    // unfolds itself on the next click is worse than no fold at all.
    await clickNav("Users");
    expect(currentPath()).toBe("/admin/users");
    expect(navGroupList("AI").hidden).toBe(true);

    // ...and it survives a full remount, which is what a refresh or a
    // deep-linked reload actually does to this component.
    await act(() => {
      root.unmount();
      return Promise.resolve();
    });
    root = createRoot(container);
    await renderConsole("groups");
    expect(navGroupList("AI").hidden).toBe(true);
    // The fold is a preference, not a hard hide: reopening it is one click.
    await act(() => {
      navGroupToggle("AI")?.click();
      return Promise.resolve();
    });
    expect(navGroupList("AI").hidden).toBe(false);
  });

  it("flags the edge with more nav behind it instead of scrolling silently", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("overview");

    const nav = navElement();
    const scroll = () =>
      act(() => {
        nav.dispatchEvent(new Event("scroll"));
        return Promise.resolve();
      });

    // 900px of sections in an 843px-tall nav, parked at the top: the only
    // thing hidden is below.
    stubScrollGeometry(nav, { clientHeight: 843, scrollHeight: 900, scrollTop: 0 });
    await scroll();
    expect(nav.hasAttribute("data-overflow-bottom")).toBe(true);
    expect(nav.hasAttribute("data-overflow-top")).toBe(false);

    stubScrollGeometry(nav, { clientHeight: 843, scrollHeight: 900, scrollTop: 30 });
    await scroll();
    expect(nav.hasAttribute("data-overflow-top")).toBe(true);
    expect(nav.hasAttribute("data-overflow-bottom")).toBe(true);

    stubScrollGeometry(nav, { clientHeight: 843, scrollHeight: 900, scrollTop: 57 });
    await scroll();
    expect(nav.hasAttribute("data-overflow-top")).toBe(true);
    expect(nav.hasAttribute("data-overflow-bottom")).toBe(false);

    // A nav that fits claims nothing. A fade that is always lit is the same
    // class of lie as a scroll that is never announced.
    stubScrollGeometry(nav, { clientHeight: 843, scrollHeight: 843, scrollTop: 0 });
    await scroll();
    expect(nav.hasAttribute("data-overflow-top")).toBe(false);
    expect(nav.hasAttribute("data-overflow-bottom")).toBe(false);

    // The fades are paint, not content.
    const fades = [...nav.querySelectorAll(".admin-nav-fade")];
    expect(fades).toHaveLength(2);
    expect(fades.every((fade) => fade.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("scrolls the active section into view when it sits below the fold", async () => {
    const targets: Element[] = [];
    const scrollIntoView = vi.fn(function trackTarget(this: Element) {
      targets.push(this);
    });
    // jsdom implements no layout and therefore no scrollIntoView; the sidebar
    // feature-detects it, so this spy is what makes the branch reachable.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    try {
      mockJsonResponse(fetchMock, apiUsers);

      // Services is the last row in the last group — the one measured below
      // the fold. Deep-linking to it must not open a nav that looks like it
      // does not contain the section you asked for.
      await renderConsole("services");

      const active = container.querySelector('a.admin-nav-link[aria-current="page"]');
      expect(active?.textContent?.trim()).toBe("Services");
      expect(targets).toContain(active);
      // `nearest` so it never yanks a nav the operator has scrolled themselves.
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("navigates to each admin section from the sidebar and updates the URL", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole();

    await clickNav("Groups & org units");
    expect(container.textContent).toContain("Organizational Units");
    expect(currentPath()).toBe("/admin/groups");

    await clickNav("Policies");
    // The policies section renders real data only. With fetch mocked to
    // return the users payload, the policies query errors and the section
    // surfaces its error banner rather than fabricated reference cards.
    await waitFor(() => {
      expect(container.textContent).toContain("Security policies are unavailable");
    });
    expect(currentPath()).toBe("/admin/policies");

    await clickNav("OAuth apps");
    await waitFor(() => {
      // The h1 now matches the sidebar label; asserting on the heading rather
      // than page text keeps this pinned to the section that rendered.
      expect(container.querySelector("h1")?.textContent).toBe("OAuth apps");
    });
    expect(currentPath()).toBe("/admin/oauth-apps");

    await clickNav("Workspace settings");
    await waitFor(() => {
      expect(container.textContent).toContain("Tenant settings");
    });
    expect(currentPath()).toBe("/admin/workspace-settings");

    await clickNav("Audit log");
    // The audit section now renders the live AuditLogList component, which
    // fetches from /api/admin/audit-log. The mocked fetch returns the users
    // payload here, so we assert on stable surface chrome rather than rows.
    await waitFor(() => {
      // The page's h1, not its prose. Matching on the subtitle made this test
      // fail when the copy was reworded, and matching bare text would pass on
      // the sidebar link of the same name without the section rendering at all.
      expect(container.querySelector("h1")?.textContent).toBe("Audit log");
    });
    expect(currentPath()).toBe("/admin/audit");

    await clickNav("Domains");
    // The Domains section now renders real domains only. With fetch mocked to
    // return the users payload, the domains query errors and the section
    // surfaces its error banner rather than fabricated DNS records.
    await waitFor(() => {
      expect(container.textContent).toContain("Domains are unavailable");
    });
    expect(currentPath()).toBe("/admin/domains");
  });

  it("wires the Users table to the admin users API", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });
    // disabledAt -> suspended status projection
    expect(container.textContent).toContain("suspended");
    const requestedUsers = fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : "";
      return url.includes("/api/admin/users");
    });
    expect(requestedUsers).toBe(true);
  });

  it("shows local email/password login alongside the SSO policy", async () => {
    mockAdminSecurityResponses(fetchMock);

    await renderConsole("policies");

    await waitFor(() => {
      expect(container.textContent).toContain("Single sign-on (SSO)");
      expect(container.textContent).toContain("Provider: google");
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Local email/password: enabled");
      expect(container.textContent).toContain("Owner/admin recovery path; SSO is additive.");
    });
    expect((container.textContent ?? "").indexOf("Local email/password login")).toBeLessThan(
      (container.textContent ?? "").indexOf("Single sign-on (SSO)"),
    );

    const editSso = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit Single sign-on (SSO)"]',
    );
    if (!editSso) {
      throw new Error("SSO edit button not found");
    }
    await act(() => {
      editSso.click();
      return Promise.resolve();
    });

    const localLogin = container.querySelector<HTMLInputElement>(
      'input[aria-label="Local email/password login enabled"]',
    );
    expect(container.textContent).toContain("Local email/password login remains enabled");
    expect(localLogin?.checked).toBe(true);
    expect(localLogin?.disabled).toBe(true);
  });

  it("shows the empty-state row when the users API returns no rows", async () => {
    mockJsonResponse(fetchMock, { users: [], nextCursor: null });

    await renderConsole("users");

    await waitFor(() => {
      expect(container.textContent).toContain("No users match the current filters.");
    });
  });

  it("filters users by search query (using real API rows)", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
      expect(container.textContent).toContain("Marcus Bell");
    });

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Filter users"]');
    if (!search) {
      throw new Error("Search input not found");
    }
    await act(() => {
      setInputValue(search, "marcus");
      return Promise.resolve();
    });

    expect(container.textContent).toContain("Marcus Bell");
    expect(container.textContent).not.toContain("Mira Okafor");
  });

  it("shows bulk actions when users are selected", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await renderConsole("users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });

    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all users"]',
    );
    if (!selectAll) {
      throw new Error("Select-all checkbox not found");
    }
    await act(() => {
      selectAll.click();
      return Promise.resolve();
    });

    expect(container.textContent).toContain("selected");
    expect(container.textContent).toContain("Change role");
    expect(container.textContent).toContain("Suspend");
  });

  it("renders billing usage rollups from the billing API", async () => {
    mockAdminBillingResponses(fetchMock);

    await renderConsole("billing");

    await waitFor(() => {
      expect(container.textContent).toContain("Billing-period usage");
      expect(container.textContent).toContain("Business Plus");
      expect(container.textContent).toContain("Upgrade plan");
      expect(container.textContent).toContain("AI tokens");
      expect(container.textContent).toContain("1,234");
      expect(container.textContent).toContain("Average storage");
      expect(container.textContent).toContain("2.0 MB");
      expect(container.textContent).toContain("Max seats");
      expect(container.textContent).toContain("12");
    });

    const planChangeLink = container.querySelector<HTMLAnchorElement>(
      'a[href^="mailto:sales@helix.example"]',
    );
    expect(planChangeLink?.href).toContain("Current%20plan%3A%20Business%20Plus");

    const metricFilter = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Usage metric filter"]',
    );
    const fromFilter = container.querySelector<HTMLInputElement>(
      'input[aria-label="Usage from date"]',
    );
    const toFilter = container.querySelector<HTMLInputElement>('input[aria-label="Usage to date"]');
    if (metricFilter === null || fromFilter === null || toFilter === null) {
      throw new Error("Usage filters were not rendered.");
    }

    await act(() => {
      setSelectValue(metricFilter, "storage_avg_bytes");
      setInputValue(fromFilter, "2026-05-01");
      setInputValue(toFilter, "2026-05-31");
      return Promise.resolve();
    });

    await waitFor(() => {
      const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
      expect(requestedUrls).toContain(
        "/api/admin/billing/usage?from=2026-05-01&to=2026-05-31&metricKey=storage_avg_bytes",
      );
    });
  });

  it("states a total billing outage once and retries every billing query", async () => {
    mockAdminBillingFailure(fetchMock, 403);

    await renderConsole("billing");

    await waitFor(() => {
      expect(container.textContent).toContain("Billing data is unavailable");
    });
    // One page-level state, not one banner per failed query.
    expect(pageAlerts()).toHaveLength(1);
    // A 403 is a permissions story, not an unreachable-service story.
    expect(container.textContent).toContain("may not have permission to read billing");
    // …and the raw failure stays on screen to quote to support.
    expect(container.textContent).toContain("Failed to load billing account (403).");
    expect(container.textContent).not.toContain("Recent invoices are unavailable");
    expect(container.textContent).not.toContain("Billing-period usage is unavailable");

    mockAdminBillingResponses(fetchMock);
    fetchMock.mockClear();
    await clickButton("Retry");

    await waitFor(() => {
      expect(container.textContent).toContain("Business Plus");
    });
    const retried = fetchMock.mock.calls
      .map(([input]) => requestUrl(input))
      .filter((url) => url.includes("/api/admin/billing/"));
    expect(retried.some((url) => url.includes("/account"))).toBe(true);
    expect(retried.some((url) => url.includes("/invoices"))).toBe(true);
    expect(retried.some((url) => url.includes("/usage"))).toBe(true);
    expect(pageAlerts()).toHaveLength(0);
  });

  it("retries a single failed billing panel and disables its filters meanwhile", async () => {
    let usageCalls = 0;
    let releaseUsageRetry = (): void => undefined;
    // The retried usage request hangs until released, so the in-flight state of
    // the Retry button is observable rather than a race.
    const heldUsageResponse = new Promise<Response>((resolve) => {
      releaseUsageRetry = () => {
        resolve(Response.json(apiUsageRollups));
      };
    });
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/admin/billing/account")) {
        return Promise.resolve(Response.json(apiBillingAccount));
      }
      if (url.includes("/api/admin/billing/invoices")) {
        return Promise.resolve(Response.json(apiInvoices));
      }
      if (url.includes("/api/admin/billing/usage")) {
        usageCalls += 1;
        return usageCalls === 1
          ? Promise.resolve(Response.json({}, { status: 503 }))
          : heldUsageResponse;
      }
      return Promise.resolve(Response.json(apiUsers));
    });

    await renderConsole("billing");

    await waitFor(() => {
      expect(container.textContent).toContain("Billing-period usage is unavailable");
    });
    // A partial failure keeps its blast radius inside the panel that failed.
    expect(container.textContent).toContain("Business Plus");
    expect(container.textContent).toContain("INV-001");
    expect(container.textContent).toContain("HTTP 503");
    expect(pageAlerts()).toHaveLength(1);

    const usageFilters = () => ({
      metric: container.querySelector<HTMLSelectElement>(
        'select[aria-label="Usage metric filter"]',
      ),
      from: container.querySelector<HTMLInputElement>('input[aria-label="Usage from date"]'),
      to: container.querySelector<HTMLInputElement>('input[aria-label="Usage to date"]'),
    });
    expect(usageFilters().metric?.disabled).toBe(true);
    expect(usageFilters().from?.disabled).toBe(true);
    expect(usageFilters().to?.disabled).toBe(true);
    expect(findButton("Clear").disabled).toBe(true);

    await clickButton("Retry");

    await waitFor(() => {
      expect(findButton("Retrying…").disabled).toBe(true);
    });
    // Clicking the in-flight button again must not queue a second request.
    await clickButton("Retrying…");
    expect(usageCalls).toBe(2);

    await act(async () => {
      releaseUsageRetry();
      await Promise.resolve();
    });

    // "1,234" is the released rollup quantity; "AI tokens" alone would match the
    // metric filter's own option label whether or not the retry landed.
    await waitFor(() => {
      expect(container.textContent).toContain("1,234");
      expect(pageAlerts()).toHaveLength(0);
    });
    expect(usageFilters().metric?.disabled).toBe(false);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : "";
}
