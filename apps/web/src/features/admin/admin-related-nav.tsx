/**
 * Sibling deep-links under an Admin section group (AI, Apps, …).
 * Keeps cross-links consistent: same chip style, same URL shape.
 *
 * These were plain `<a href>` anchors, "so section unit tests need no
 * RouterProvider". That traded the operator's navigation for test setup: a
 * same-origin anchor inside a SPA is a full document reload — entry bundle
 * re-parsed, `getSessionUser()` round trip, and every warm React Query entry in
 * the workspace discarded. It made the convenience shortcut by far the slowest
 * way to move between two admin pages.
 *
 * The section tests that mount a page bare now wrap it in the same memory
 * router harness `admin-console.test.tsx` already uses.
 */

import { Link } from "@tanstack/react-router";
import type { AdminSectionId } from "@/features/admin/admin-console-data";

export interface AdminRelatedNavItem {
  readonly section: AdminSectionId;
  readonly label: string;
  /** Optional search fragment, e.g. `{ tab: "spam" }`. */
  readonly search?: Record<string, string | undefined>;
  readonly current?: boolean;
}

/** Drop empty values so a chip without a deep link lands on the clean
 *  `/admin/<section>` URL rather than `/admin/<section>?tab=`. */
function adminSearch(search?: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(search ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      next[key] = value;
    }
  }
  return next;
}

export function AdminRelatedNav({
  ariaLabel,
  items,
}: {
  readonly ariaLabel: string;
  readonly items: readonly AdminRelatedNavItem[];
}) {
  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {items.map((item) => {
        if (item.current === true) {
          return (
            <span key={item.section + item.label} className="chip success" aria-current="page">
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.section + item.label}
            className="chip"
            to="/admin/$section"
            params={{ section: item.section }}
            search={adminSearch(item.search)}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Standard AI group sibling strip. */
export function AdminAiRelatedNav({ current }: { readonly current: AdminSectionId }) {
  return (
    <AdminRelatedNav
      ariaLabel="Related AI admin pages"
      items={[
        {
          section: "ai-providers",
          label: "AI providers",
          current: current === "ai-providers",
        },
        {
          section: "ai-costs",
          label: "Cost limits",
          current: current === "ai-costs",
        },
        {
          section: "ai-observability",
          label: "Observability",
          current: current === "ai-observability",
        },
        {
          section: "agent-controls",
          label: "Agent emergency controls",
          current: current === "agent-controls",
        },
        {
          section: "mail",
          label: "Mail spam",
          search: { tab: "spam" },
          current: false,
        },
      ]}
    />
  );
}

/** Access credentials + emergency controls under Apps & integrations. */
export function AdminAccessRelatedNav({ current }: { readonly current: AdminSectionId }) {
  return (
    <AdminRelatedNav
      ariaLabel="Related access and agent admin pages"
      items={[
        {
          section: "app-passwords",
          label: "App passwords",
          current: current === "app-passwords",
        },
        {
          section: "agent-credentials",
          label: "Agent credentials",
          current: current === "agent-credentials",
        },
        {
          section: "agent-controls",
          label: "Agent emergency controls",
          current: current === "agent-controls",
        },
        {
          section: "oauth-apps",
          label: "OAuth apps",
          current: current === "oauth-apps",
        },
      ]}
    />
  );
}

/** Security group siblings. */
export function AdminSecurityRelatedNav({ current }: { readonly current: AdminSectionId }) {
  return (
    <AdminRelatedNav
      ariaLabel="Related security admin pages"
      items={[
        {
          section: "policies",
          label: "Policies",
          current: current === "policies",
        },
        {
          section: "identity",
          label: "Identity & SSO",
          current: current === "identity",
        },
        {
          section: "tier-readiness",
          label: "Tier readiness",
          current: current === "tier-readiness",
        },
        {
          section: "audit",
          label: "Audit log",
          current: current === "audit",
        },
      ]}
    />
  );
}
