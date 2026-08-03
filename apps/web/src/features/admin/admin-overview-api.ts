/* Admin › Overview — the whole landing page in one request.
 *
 * Overview reads five figures. As five requests that is the entirety of the
 * tenant's five-per-second budget (`api_rps_limit`) on top of the three the app
 * shell already spends, so the console's front door could not load without
 * tripping the limiter it exists to report on. It carried a release queue to
 * stagger them — about a second of deliberate self-throttling — and still took
 * a 429 on a genuinely cold load.
 *
 * `GET /api/admin/overview` fans out server-side instead. See
 * `apps/helix/src/platform/admin/overview.ts`: the readers there are the same
 * functions the individual endpoints use, so this cannot drift away from the
 * section pages.
 *
 * WHAT THE ENVELOPE IS FOR
 *
 * Each signal reports its own status. That is not incidental — it is what keeps
 * Overview honest. The page's rule is that a figure may only be rendered from a
 * response that actually arrived, and with five separate requests one dead
 * endpoint left the other four cards accurate for free. A plain aggregate would
 * have turned any single failure into five blank cards, which is a worse
 * reading, not a cheaper one.
 */

import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import type { AdminUsersListResponse } from "@/features/admin/admin-users";
import type { CoreAppsAdminStatus } from "@/features/admin/core-apps-api";
import type { DomainWithRecords } from "@/features/admin/domains-api";
import type { SecurityPolicy } from "@/features/admin/security-policies-api";
import type { PlatformConfigStatus } from "@/features/admin/tier-readiness/types";

/** Only the envelope is validated here. The payloads are the same bodies the
 *  section endpoints return, produced by the same server code, and each section
 *  page validates its own when opened — re-declaring five schemas would create
 *  a second definition to keep in step for no extra safety. What must be
 *  trustworthy is the `status` discriminator, because that is what decides
 *  whether a number is allowed on screen at all. */
const signalSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

const overviewSchema = z.object({
  signals: z.object({
    domains: signalSchema,
    policies: signalSchema,
    platformConfig: signalSchema,
    directory: signalSchema,
    coreApps: signalSchema,
  }),
});

export type AdminOverviewSignalName = keyof z.infer<typeof overviewSchema>["signals"];

/** One signal's reading, already narrowed to the type its card expects. */
export type AdminOverviewSignal<Data> =
  | { readonly status: "ok"; readonly data: Data }
  | { readonly status: "unavailable"; readonly reason: string };

/** The payload type for one signal name — lets a caller narrow
 *  `signals.domains` to the domains body without a cast at every use. */
export type AdminOverviewSignalData<K extends AdminOverviewSignalName> =
  AdminOverview[K] extends AdminOverviewSignal<infer Data> ? Data : never;

export interface AdminOverview {
  /* Unwrapped to match what the section queries hand their readers — the
     endpoints wrap these in `{ domains }` / `{ policies }`, and Overview's card
     readers take the bare list. Unwrapping here keeps one reader shape rather
     than forking it by data source. */
  readonly domains: AdminOverviewSignal<readonly DomainWithRecords[]>;
  readonly policies: AdminOverviewSignal<readonly SecurityPolicy[]>;
  readonly platformConfig: AdminOverviewSignal<PlatformConfigStatus>;
  readonly directory: AdminOverviewSignal<AdminUsersListResponse>;
  readonly coreApps: AdminOverviewSignal<CoreAppsAdminStatus>;
}

export const adminOverviewQueryKey = ["admin", "overview"] as const;

export function adminOverviewQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminOverviewQueryKey,
    queryFn: () => fetchAdminOverview(fetchImpl),
  });
}

export async function fetchAdminOverview(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AdminOverview> {
  const response = await fetchImpl("/api/admin/overview");
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    /* Only a *string* `error` is a message. The rate limiter answers with a
       nested envelope (`{ error: { code, message, traceId } }`), and taking that
       object as the message produced "[object Object]" — which has no trailing
       status, so `isRateLimited` could not see the 429 and the shared retry
       never fired. A refused page then stayed refused: exactly the permanent
       failure the retry exists to prevent. */
    const error = (payload as { readonly error?: unknown }).error;
    throw new Error(
      typeof error === "string"
        ? error
        : `Failed to load the admin overview (${String(response.status)}).`,
    );
  }
  const parsed = overviewSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Failed to load the admin overview: malformed response.");
  }
  /* The cast is the trade documented above: the envelope is verified, the inner
     bodies are the section endpoints' own shapes. */
  const signals = parsed.data.signals;
  return {
    ...signals,
    domains: unwrap(signals.domains, "domains"),
    policies: unwrap(signals.policies, "policies"),
  } as AdminOverview;
}

/** Lift `{ domains: [...] }` to `[...]` without inventing a list: an
 *  `unavailable` signal passes through untouched, and a malformed `ok` body
 *  becomes `unavailable` rather than an empty array that would read as "none". */
function unwrap(signal: AdminOverviewSignal<unknown>, key: string): AdminOverviewSignal<unknown> {
  if (signal.status !== "ok") {
    return signal;
  }
  const inner = (signal.data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(inner)) {
    return { status: "unavailable", reason: `The ${key} reading was malformed.` };
  }
  return { status: "ok", data: inner };
}

interface AdminOverviewRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminOverviewQueryOptions>): Promise<unknown>;
}

/** Warm the whole page from the route loader.
 *
 *  One request now, so unlike the five it replaced there is nothing to pace and
 *  no reason to warm only part of it. */
export async function prefetchAdminOverviewQueries(queryClient: AdminOverviewRouteQueryClient) {
  await queryClient.ensureQueryData(adminOverviewQueryOptions()).catch(() => undefined);
}
