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

/** A group's sibling list, with the page you are on marked as current. Each
 *  strip is otherwise just `[section, label]` data. */
function siblings(
  current: AdminSectionId,
  entries: readonly (readonly [AdminSectionId, string])[],
): readonly AdminRelatedNavItem[] {
  return entries.map(([section, label]) => ({ section, label, current: section === current }));
}

/** Standard AI group sibling strip. */
export function AdminAiRelatedNav({ current }: { readonly current: AdminSectionId }) {
  return (
    <AdminRelatedNav
      ariaLabel="Related AI admin pages"
      items={[
        ...siblings(current, [
          ["ai-providers", "AI providers"],
          ["ai-costs", "Cost limits"],
          ["ai-observability", "Observability"],
          ["agent-controls", "Agent emergency controls"],
        ]),
        /* Never current: this one deep-links into a tab of another section
           rather than naming a page in this group. */
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
      items={siblings(current, [
        ["app-passwords", "App passwords"],
        ["agent-credentials", "Agent credentials"],
        ["agent-controls", "Agent emergency controls"],
        ["oauth-apps", "OAuth apps"],
      ])}
    />
  );
}

/** Security group siblings. */
export function AdminSecurityRelatedNav({ current }: { readonly current: AdminSectionId }) {
  return (
    <AdminRelatedNav
      ariaLabel="Related security admin pages"
      items={siblings(current, [
        ["policies", "Policies"],
        ["identity", "Identity & SSO"],
        ["tier-readiness", "Tier readiness"],
        ["audit", "Audit log"],
      ])}
    />
  );
}
