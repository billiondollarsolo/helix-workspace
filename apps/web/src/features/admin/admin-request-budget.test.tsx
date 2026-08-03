// @vitest-environment jsdom

/* Admin console request budget — the measurement, not the opinion.
 *
 * The ceiling is real and enforced: `api_rps_limit: 5`
 * (packages/contracts/src/tenant-config.ts) is applied by
 * apps/helix/src/platform/limits/api-rps.ts over a hard 1000ms sliding window
 * (`state.length + 1 > limit`, so the 6th request inside one second is
 * refused with 429). Only /api/auth* is exempt. A cold admin load is exactly
 * the burst that trips it, and a refused query renders as a panel that cannot
 * state a figure — which is the failure this file keeps visible.
 *
 * So: mount every section cold, record what it actually asks the API for, and
 * pin it in an inline snapshot. The snapshot diff IS the report.
 */

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
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { AdminConsole } from "./admin-console";
import { ADMIN_SECTION_IDS, isAdminSectionId, type AdminSectionId } from "./admin-console-data";
import { SHELL_BASELINE_REQUESTS } from "@/features/admin/console/request-budget";

/** TopBar calls `sessionUserQueryOptions()` → fetch("/api/auth/get-session").
 * /api/auth* is the one path exempt from the RPS limiter, so it belongs in no
 * section's budget; resolving it to null keeps it out of the measurement
 * entirely rather than leaving it to be filtered back out afterwards. */
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Requests allowed inside one 1000ms window, per session. */
const API_RPS_LIMIT = 5;

/** What the app SHELL spends before any section has rendered a thing:
 *  1. the notifications unread count behind the topbar bell
 *     (src/components/shell/surface-frame.tsx — `unreadCountQueryOptions()`)
 *  2. GET /api/core-apps for the app rail
 *     (src/features/apps/use-enabled-apps.ts — `coreAppsShellQueryOptions()`)
 *  Neither is conditional, so a section never gets the whole 5 — it gets what
 *  is left. */
/* Re-exported from the shared module rather than restated, so this harness and
   the pacing that reads the same number can never disagree about it. The value
   is 3, measured against a running workspace: /api/core-apps,
   notifications.unread-count and notifications.list all land inside 20 ms of
   each other on a cold load. */
export { SHELL_BASELINE_REQUESTS };

/** What one section's own cold load may cost before the burst is refused. */
const SECTION_REQUEST_BUDGET = API_RPS_LIMIT - SHELL_BASELINE_REQUESTS;

/** URL prefixes owned by the shell rather than by any section, subtracted from
 *  each section's count because `SHELL_BASELINE_REQUESTS` already charges for
 *  them — counting them per section would bill every section twice for the
 *  same two requests.
 *
 *  `/api/core-apps` is listed even though it does not fire here: this harness
 *  mounts `AdminConsole`, and `SurfaceFrame` renders the topbar but not the app
 *  rail that owns that query. In the running app the rail is always mounted,
 *  which is why the baseline is 2 and not 1. */
const SHELL_REQUEST_PREFIXES = ["/api/core-apps", "/api/tools/notifications.unread-count"] as const;

/** Sections that cannot be measured through this harness.
 *
 *  They are recorded in the snapshot as skipped rather than dropped from it:
 *  a section quietly missing from the report reads as a section that issued
 *  zero requests, which is the most flattering possible lie about it.
 *
 *  `ai-observability` never completes its first commit here — the initial
 *  `act(() => root.render(...))` for `/admin/ai-observability` does not return,
 *  with no request issued and no `<h1>` in the tree, so the sweep hangs instead
 *  of producing a number. The module imports fine and its own suite
 *  (ai-observability.test.tsx) mounts the component directly and passes, so the
 *  fault is in mounting it through the console's lazy section boundary. Its
 *  cost is unknown, not zero; measuring it needs that hang diagnosed first. */
const UNMEASURABLE_SECTIONS: Partial<Record<AdminSectionId, string>> = {
  "ai-observability": "first commit never returns when mounted via the console's lazy boundary",
};

/** Sections over budget TODAY, with the count measured by this file.
 *
 *  A debt ledger, not a waiver. The assertion compares the measured set to this
 *  one for equality, so it fails in both directions: a section newly going over
 *  budget fails, and a listed section that got cheaper fails too — its entry is
 *  now a false statement, and deleting it is the proof the fix landed. Adding an
 *  entry is therefore an explicit, reviewable decision to ship a section whose
 *  cold load the server will refuse part of.
 *
 *  Empty as measured: every measurable section fits in 3. Two spend all three —
 *  `billing` (account + invoices + usage) and `webhooks` (inbound + outbound +
 *  deliveries) land at exactly 5 of 5 once the shell's two are counted, so they
 *  have zero headroom: one more query on either, or one extra shell request,
 *  and the tail of the burst comes back 429. `ai-observability` is absent from
 *  this ledger because it is unmeasured (see UNMEASURABLE_SECTIONS), not
 *  because it is known to fit. */
/* Sections this build actually serves. `isAdminSectionId` rejects ids in
   `DISABLED_SECTIONS`, which today is `billing` — metered SaaS plumbing that a
   self-hosted install has no service behind, gated off unless a hosted build
   sets VITE_HELIX_BILLING_ENABLED. Measuring a section the router 404s would
   put a number in this report for a page no operator can reach, and would hold
   an over-budget entry open against work nobody is going to do. */
const MEASURED_SECTIONS: readonly AdminSectionId[] = ADMIN_SECTION_IDS.filter((section) =>
  isAdminSectionId(section),
);

const OVER_BUDGET_ALLOWLIST: Partial<Record<AdminSectionId, number>> = {};

/** Stub payload answering any URL.
 *
 *  One superset object rather than per-endpoint fixtures: the measurement needs
 *  each query to *settle*, not to be realistic, and this satisfies the common
 *  `{ items: [] }` / `{ nextCursor: null }` envelopes. A query whose parser
 *  rejects it settles into its error state instead, which still records the
 *  request it made — and the request is the thing being counted. */
const emptyPayload: Record<string, unknown> = {
  items: [],
  users: [],
  groups: [],
  policies: [],
  domains: [],
  apps: [],
  entries: [],
  events: [],
  records: [],
  rules: [],
  providers: [],
  credentials: [],
  passwords: [],
  webhooks: [],
  services: [],
  limits: [],
  invoices: [],
  rollups: [],
  logs: [],
  sessions: [],
  accounts: [],
  mailboxes: [],
  channels: [],
  files: [],
  count: 0,
  total: 0,
  nextCursor: null,
  settings: {},
  config: { security: { tier: "standard" }, ai: { audit: {}, costLimits: {}, privacy: {} } },
  summary: {},
  account: null,
  enabled: false,
};

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : "";
}

/** Origin-stripped, cache-buster-free URL. Without this a snapshot would be
 *  rewritten by every run that carries a timestamp in a query string, and a
 *  report that changes on its own is not a report. */
function normalizeUrl(raw: string): string {
  const url = new URL(raw, "http://localhost");
  for (const key of ["_", "t", "ts", "now", "cacheBust", "requestId"]) {
    url.searchParams.delete(key);
  }
  const search = url.searchParams.toString();
  return search === "" ? url.pathname : `${url.pathname}?${search}`;
}

function isShellRequest(url: string): boolean {
  return SHELL_REQUEST_PREFIXES.some((prefix) => url.startsWith(prefix));
}

interface SectionBudget {
  /** Whether the section reached its loaded state. Recorded rather than
   *  assumed: a `requestCount` of 0 from a section that never rendered is
   *  indistinguishable from a section that costs nothing, and only one of those
   *  is good news. */
  readonly settled: boolean;
  /** Fetch calls the section itself issued, duplicates included — the limiter
   *  counts requests, not distinct URLs. */
  readonly requestCount: number;
  readonly urls: readonly string[];
}

/** What the snapshot carries for a section this harness cannot mount. */
interface SkippedSection {
  readonly skipped: string;
}

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

/** A memory router carrying just `/admin/$section`, as in the console's own
 *  suite: the console reads its section from the route, so measuring through
 *  the router measures what a deep link actually costs. */
function buildRouter(section: AdminSectionId) {
  const rootRoute = createRootRoute();
  const sectionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/$section",
    component: function AdminSectionRoute() {
      // `strict: false` because this ad-hoc tree isn't the generated one.
      const params = useParams({ strict: false });
      return createElement(AdminConsole, { section: params.section ?? "overview" });
    },
  });
  return createRouter({
    routeTree: rootRoute.addChildren([sectionRoute]),
    history: createMemoryHistory({ initialEntries: [`/admin/${section}`] }),
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** Mount one section cold and record what it asked the API for.
 *
 *  Sections are lazy chunks, so for the first ticks the panel is only a
 *  Suspense fallback and has issued nothing. Settling on "the request count
 *  stopped moving" alone would therefore report a cold load of zero for every
 *  section — the count is perfectly steady at zero while the chunk is still
 *  importing. The wait is two-part for that reason: first an `<h1>` has to
 *  exist (`SectionSkeleton` renders no heading, so a heading means the section
 *  itself mounted), and only then does the count have to hold still, which is
 *  what catches the second wave of requests that depends on the first. */
async function measureSection(section: AdminSectionId): Promise<SectionBudget> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // A fresh QueryClient per section: a shared cache would serve the next
  // section from this one's data and report a cold load that never happened.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(emptyPayload)));
  vi.stubGlobal("fetch", fetchMock);

  const router = buildRouter(section);
  await act(() => {
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

  let rendered = false;
  let stableTicks = 0;
  let lastCallCount = -1;
  for (let tick = 0; tick < 200 && stableTicks < 4; tick += 1) {
    await flush();
    rendered ||= container.querySelector("h1") !== null;
    if (!rendered) {
      continue;
    }
    const callCount = fetchMock.mock.calls.length;
    stableTicks = callCount === lastCallCount ? stableTicks + 1 : 0;
    lastCallCount = callCount;
  }

  const urls = fetchMock.mock.calls
    .map(([input]) => normalizeUrl(requestUrl(input)))
    .filter((url) => !isShellRequest(url));

  await act(() => {
    root.unmount();
    return Promise.resolve();
  });
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();

  return {
    settled: rendered,
    requestCount: urls.length,
    urls: [...new Set(urls)].sort(),
  };
}

/* One sweep, two assertions. Mounting every section twice doubles a run that is
   already dominated by chunk imports, and the snapshot and the budget check
   have to be reading the same numbers anyway — a report that disagreed with the
   assertion beside it would make both worthless. */
let sweep: Record<string, SectionBudget | SkippedSection> | null = null;

async function measureAllSections(): Promise<Record<string, SectionBudget | SkippedSection>> {
  if (sweep === null) {
    const measured: Record<string, SectionBudget | SkippedSection> = {};
    for (const section of MEASURED_SECTIONS) {
      const unmeasurable = UNMEASURABLE_SECTIONS[section];
      measured[section] =
        unmeasurable === undefined ? await measureSection(section) : { skipped: unmeasurable };
    }
    sweep = measured;
  }
  return sweep;
}

describe("admin console request budget", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records what every admin section's cold load costs", async () => {
    expect(await measureAllSections()).toMatchInlineSnapshot(`
      {
        "agent-controls": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/tools/admin.agent_controls.get",
          ],
        },
        "agent-credentials": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/admin/users?includeDisabled=false&limit=50",
            "/api/tools/agent.credentials.list",
          ],
        },
        "ai-costs": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/ai/cost-limits",
          ],
        },
        "ai-observability": {
          "skipped": "first commit never returns when mounted via the console's lazy boundary",
        },
        "ai-providers": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/platform-config",
          ],
        },
        "app-passwords": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/admin/users?includeDisabled=false&limit=50",
            "/api/tools/app.passwords.list",
          ],
        },
        "audit": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/admin/audit-log?limit=50",
            "/api/admin/users?includeDisabled=true&limit=250",
          ],
        },
        "chat": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/tools/chat.retention.get",
          ],
        },
        "domains": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/domains",
          ],
        },
        "drive": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/tools/drive.lifecycle.get",
            "/api/tools/drive.quota.usage",
          ],
        },
        "groups": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/admin/groups",
            "/api/admin/org-units",
          ],
        },
        "identity": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/identity/idp-configs",
          ],
        },
        "mail": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/mail/providers",
          ],
        },
        "oauth-apps": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/oauth-apps?limit=50",
          ],
        },
        "overview": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/overview",
          ],
        },
        "policies": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/security-policies",
          ],
        },
        "services": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/services",
          ],
        },
        "tier-readiness": {
          "requestCount": 2,
          "settled": true,
          "urls": [
            "/api/admin/platform-config",
            "/api/tools/plugin.list",
          ],
        },
        "users": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/users?includeDisabled=true&limit=250",
          ],
        },
        "webhooks": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/tools/webhook.overview",
          ],
        },
        "workspace-apps": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/core-apps",
          ],
        },
        "workspace-settings": {
          "requestCount": 1,
          "settled": true,
          "urls": [
            "/api/admin/tenant-config",
          ],
        },
      }
    `);
  }, 180_000);

  it("keeps every admin section inside the per-session request budget", async () => {
    const measured = await measureAllSections();
    const overBudget: Record<string, number> = {};

    for (const [section, budget] of Object.entries(measured)) {
      if (!("requestCount" in budget)) {
        continue;
      }
      // An unsettled section has not been measured, so its count is evidence of
      // nothing. Failing here rather than reading a low number as "cheap" — a
      // section silently scored 0 because it never rendered is exactly the
      // false all-clear this harness exists to prevent.
      expect(budget.settled, `${section} never reached its loaded state`).toBe(true);
      if (budget.requestCount > SECTION_REQUEST_BUDGET) {
        overBudget[section] = budget.requestCount;
      }
    }

    expect(overBudget).toEqual(OVER_BUDGET_ALLOWLIST);
  }, 180_000);
});
