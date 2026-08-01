/* The admin console's grouped section navigation. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import {
  ADMIN_NAV_GROUPS_FOR_BUILD,
  ADMIN_NAV_ROOT,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";

/* ------------------------------------------------------------------ */
/* Collapse preference                                                 */
/* ------------------------------------------------------------------ */

/* The console re-renders (and can remount) the sidebar on every section
 * change, so collapse state cannot live in component state alone — an operator
 * who folded away four groups would watch them unfold on the next click.
 * localStorage also survives a refresh, which is the point: this is a standing
 * preference about which parts of the console you use, not a per-visit mode. */
const COLLAPSED_GROUPS_KEY = "helix.admin.nav.collapsed-groups";

function readCollapsedGroups(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    /* Anything else in this key is someone else's data or a corrupted write;
       an unreadable preference must degrade to "show everything", never throw
       the navigation away. */
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeCollapsedGroups(titles: readonly string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(titles));
  } catch {
    /* Private mode / quota. A preference that cannot be saved is not a reason
       to break the click that set it. */
  }
}

/** `aria-labelledby` and `aria-controls` take space-separated IDREFs, so an id
 *  may not contain whitespace — "Apps & integrations" tokenised into three ids
 *  that do not exist, leaving that group's list unnamed. */
function groupSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

/* ------------------------------------------------------------------ */
/* Overflow affordance                                                 */
/* ------------------------------------------------------------------ */

/** Which edges of the nav have content beyond them. Measured, never assumed:
 *  a fade painted over a nav that already fits claims there is more below when
 *  there is not — the same class of lie as a silent scroll, pointing the other
 *  way. */
interface OverflowEdges {
  readonly top: boolean;
  readonly bottom: boolean;
}

function measureEdges(nav: HTMLElement): OverflowEdges {
  const scrollable = nav.scrollHeight - nav.clientHeight;
  /* 1px of slack: fractional layout rounds scrollHeight up at non-integer
     zoom levels, and a permanently-lit fade is worse than none. */
  return {
    top: nav.scrollTop > 1,
    bottom: scrollable > 1 && nav.scrollTop < scrollable - 1,
  };
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

interface AdminNavItem {
  readonly id: AdminSectionId;
  readonly label: string;
  readonly icon: keyof typeof Icons;
}

function AdminNavLink({ item, active }: { readonly item: AdminNavItem; readonly active: boolean }) {
  const Icon = Icons[item.icon];
  return (
    <Link
      to="/admin/$section"
      params={{ section: item.id }}
      aria-current={active ? "page" : undefined}
      className="admin-nav-link"
      data-active={active ? "" : undefined}
    >
      <Icon />
      <span>{item.label}</span>
    </Link>
  );
}

/* No "Administration" heading above the list: the TopBar title and the
 * highlighted rail icon already say where you are, and 19 sections plus six
 * group headings need the vertical space more than a third label does.
 *
 * Those 19 sections still do not fit a laptop viewport — 882px of content in
 * an 843px nav at compact density, and ~190px over at
 * `[data-density="comfortable"]`, whose 44px rows are a density token we do
 * not get to shrink. Three things share the load, in this order:
 *
 *   1. The overflow is signposted. A sticky gradient at whichever edge has
 *      content past it, plus a permanently visible scrollbar, so "more below"
 *      is never something you have to discover by accident.
 *   2. The active section is scrolled into view on arrival, so deep-linking to
 *      Services (the last row) does not open a nav that appears to be missing
 *      it.
 *   3. Groups fold, so an operator who never touches AI or Platform can make
 *      the rest fit for good.
 *
 * Folding is opt-in and starts fully expanded: hiding a section by default to
 * win vertical space trades a scroll for a search, which is the worse deal.
 * The group holding the active section is always rendered open and renders no
 * toggle at all — a control that would hide the row you are standing on is not
 * a control worth shipping, and a *disabled* toggle there would just be a
 * focus stop that does nothing. Its stored preference is untouched, so the
 * group folds itself back up as soon as you navigate away. */
export function AdminSidebar({ section }: { readonly section: AdminSectionId }) {
  const navRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsedGroups);
  const [edges, setEdges] = useState<OverflowEdges>({ top: false, bottom: false });

  function toggleGroup(title: string): void {
    /* Functional update, not `collapsed` from this render's closure: two
       toggles dispatched inside one React batch both read the pre-batch
       snapshot, so the second overwrites the first and one group silently
       unfolds. Persisting from inside the updater keeps storage and state
       from disagreeing for the same reason — and writing the same value twice
       (StrictMode double-invokes updaters) is a no-op. */
    setCollapsed((previous) => {
      const next = previous.includes(title)
        ? previous.filter((entry) => entry !== title)
        : [...previous, title];
      writeCollapsedGroups(next);
      return next;
    });
  }

  /* Re-measures when the nav resizes (window height, density change) and, via
     the dependencies, when folding a group changes the content height. */
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    const measure = () => {
      setEdges((prev) => {
        const next = measureEdges(nav);
        return prev.top === next.top && prev.bottom === next.bottom ? prev : next;
      });
    };
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    /* jsdom has no ResizeObserver. The scroll listener and this effect's
       dependencies still cover every state a jsdom test can produce. */
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    /* The nav's own box also has to be watched from the inside: switching to
       `[data-density="comfortable"]` grows every row from 36px to 44px without
       changing the nav's width or height, so observing only the container
       leaves the affordance reporting the old content height. */
    for (const child of nav.children) {
      observer?.observe(child);
    }
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [collapsed, section]);

  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    /* `block: "nearest"` is deliberate: it moves the nav only when the active
       row is actually out of view, so it never yanks the list out from under
       someone who has scrolled it themselves. jsdom does not implement
       scrollIntoView, hence the guard. */
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [section]);

  return (
    <nav
      className="admin-nav"
      aria-label="Administration"
      ref={navRef}
      data-overflow-top={edges.top ? "" : undefined}
      data-overflow-bottom={edges.bottom ? "" : undefined}
    >
      {/* Sticky inside the scroll container, and pulled out of flow by a
          negative margin so the affordance costs no vertical space. */}
      <div className="admin-nav-fade admin-nav-fade-top" aria-hidden="true" />
      <AdminNavLink item={ADMIN_NAV_ROOT} active={section === ADMIN_NAV_ROOT.id} />
      {ADMIN_NAV_GROUPS_FOR_BUILD.map((group) => {
        const slug = groupSlug(group.title);
        const headingId = `admin-nav-${slug}`;
        const listId = `admin-nav-${slug}-list`;
        const holdsActive = group.items.some((item) => item.id === section);
        const open = holdsActive || !collapsed.includes(group.title);
        return (
          <div
            className="admin-nav-group"
            key={group.title}
            data-current={holdsActive ? "" : undefined}
          >
            {/* The heading names the list for assistive tech as well as sighted
                users, so the group is a real <ul> rather than styled divs. It
                stays an <h2> whether or not it carries the toggle: the
                disclosure button lives inside the heading (the WAI-ARIA
                accordion shape) rather than replacing it, so the document
                outline does not change as groups fold. */}
            <h2 className="section-label" id={headingId}>
              {holdsActive ? (
                <span className="admin-nav-group-heading">
                  <span className="admin-nav-group-label">{group.title}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="admin-nav-group-heading admin-nav-group-toggle"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => {
                    toggleGroup(group.title);
                  }}
                >
                  <span className="admin-nav-group-label">{group.title}</span>
                  {/* What is behind the fold, in the summary, per the console's
                      disclosure rule. Only while collapsed — expanded, the
                      rows themselves are the count. */}
                  {open ? null : (
                    <span
                      className="admin-nav-group-count"
                      aria-label={`${group.items.length} sections`}
                    >
                      {group.items.length}
                    </span>
                  )}
                  <Icons.ChevronDown className="admin-nav-group-chevron" size={14} />
                </button>
              )}
            </h2>
            {/* `hidden`, not a CSS height collapse: a visually-hidden list that
                is still in the tab order is the classic disclosure bug — you
                tab into rows nobody can see. */}
            <ul id={listId} aria-labelledby={headingId} hidden={!open}>
              {group.items.map((item) => (
                <li key={item.id}>
                  <AdminNavLink item={item} active={section === item.id} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="admin-nav-fade admin-nav-fade-bottom" aria-hidden="true" />
    </nav>
  );
}
