/**
 * Deep-link helpers for Admin `/admin/$section` search params.
 *
 * Section-local navigation that should survive refresh, share, and
 * back/forward lives in the URL (AGENTS.md). Tabs use `?tab=`; other
 * closed or free-text keys (tier, policy, filters) use dedicated params.
 */

import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  optionalEnumSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
} from "@/lib/search-params";

/** Shared search bag for every admin section route. */
export interface AdminSectionSearch {
  /** Section subview (mail tabs, webhook tabs, …). */
  readonly tab?: string;
  /** Tier readiness selected tier. */
  readonly tier?: string;
  /** Security policies editor focus. */
  readonly policy?: string;
  /** Users directory search string. */
  readonly q?: string;
  /** Users role filter. */
  readonly role?: string;
  /** Users actor-type filter. */
  readonly actorType?: string;
  /** Users status filter. */
  readonly status?: string;
  /** Expanded user id in the directory. */
  readonly user?: string;
  /** Plugin id on tier readiness. */
  readonly plugin?: string;
  /** Focused domain id (domains section). */
  readonly domain?: string;
}

const ADMIN_SECTION_SEARCH_KEYS = [
  "tab",
  "tier",
  "policy",
  "q",
  "role",
  "actorType",
  "status",
  "user",
  "plugin",
  "domain",
] as const satisfies readonly (keyof AdminSectionSearch)[];

export function validateAdminSectionSearch(search: Record<string, unknown>): AdminSectionSearch {
  const tab = optionalStringSearchParam(search.tab);
  const tier = optionalStringSearchParam(search.tier);
  const policy = optionalStringSearchParam(search.policy);
  const q = optionalStringSearchParam(search.q);
  const role = optionalStringSearchParam(search.role);
  const actorType = optionalStringSearchParam(search.actorType);
  const status = optionalStringSearchParam(search.status);
  const user = optionalUuidSearchParam(search.user) ?? optionalStringSearchParam(search.user);
  const plugin = optionalStringSearchParam(search.plugin);
  const domain = optionalStringSearchParam(search.domain);

  return {
    ...(tab === undefined ? {} : { tab }),
    ...(tier === undefined ? {} : { tier }),
    ...(policy === undefined ? {} : { policy }),
    ...(q === undefined ? {} : { q }),
    ...(role === undefined ? {} : { role }),
    ...(actorType === undefined ? {} : { actorType }),
    ...(status === undefined ? {} : { status }),
    ...(user === undefined ? {} : { user }),
    ...(plugin === undefined ? {} : { plugin }),
    ...(domain === undefined ? {} : { domain }),
  };
}

/** Resolve a closed enum from a URL value; unknown → default. */
export function resolveClosedSearchParam<const TValue extends string>(
  value: string | undefined,
  allowed: readonly TValue[],
  defaultValue: TValue,
): TValue {
  return optionalEnumSearchParam(value, allowed) ?? defaultValue;
}

/**
 * Build a search fragment that sets `key` only when non-default / non-empty.
 * Pass `defaultValue` for closed enums so the default is omitted from the URL.
 */
export function adminSearchForKey(
  key: keyof AdminSectionSearch,
  value: string | undefined,
  defaultValue?: string,
): Partial<AdminSectionSearch> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }
  if (defaultValue !== undefined && value === defaultValue) {
    return {};
  }
  return { [key]: value };
}

function asSearchRecord(previous: unknown): Record<string, unknown> {
  if (typeof previous === "object" && previous !== null) {
    return { ...(previous as Record<string, unknown>) };
  }
  return {};
}

function stripAdminSearchKeys(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const key of ADMIN_SECTION_SEARCH_KEYS) {
    delete next[key];
  }
  return next;
}

/**
 * Read/patch the current admin section's search params.
 * `section` is the `/admin/<section>` segment (required so tests need not
 * mount a full router for `useParams`).
 */
/* Which keys are *filter* state rather than *place* state.
 *
 * Every update used to push a history entry, so Back walked the operator back
 * through their own typing one character at a time instead of returning to the
 * page they came from. A tab switch is somewhere you went and should be
 * reversible; a search box's third keystroke is not. Anything touching only
 * these keys replaces the entry instead of pushing one. */
const FILTER_SEARCH_KEYS: ReadonlySet<string> = new Set([
  "q",
  "role",
  "actorType",
  "status",
  "user",
  "policy",
  "plugin",
  "domain",
]);

function isFilterOnlyPatch(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => FILTER_SEARCH_KEYS.has(key));
}

export function useAdminSectionSearch(section: string): {
  readonly search: AdminSectionSearch;
  readonly section: string;
  readonly patchSearch: (patch: Partial<AdminSectionSearch>) => void;
  readonly replaceSearch: (
    next: AdminSectionSearch,
    options?: { readonly replace?: boolean },
  ) => void;
} {
  const navigate = useNavigate();
  const rawSearch: Record<string, unknown> = useSearch({ strict: false });
  const search = validateAdminSectionSearch(rawSearch);

  const replaceSearch = useCallback(
    (next: AdminSectionSearch, options?: { readonly replace?: boolean }) => {
      void navigate({
        to: "/admin/$section",
        params: { section: section as never },
        search: (previous) => {
          const base = stripAdminSearchKeys(asSearchRecord(previous));
          return { ...base, ...validateAdminSectionSearch(next as Record<string, unknown>) };
        },
        replace: options?.replace ?? false,
      });
    },
    [navigate, section],
  );

  const patchSearch = useCallback(
    (patch: Partial<AdminSectionSearch>) => {
      const next: AdminSectionSearch = { ...search };
      for (const key of ADMIN_SECTION_SEARCH_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          const value = patch[key];
          if (value === undefined || value === "") {
            delete (next as Record<string, unknown>)[key];
          } else {
            (next as Record<string, string>)[key] = value;
          }
        }
      }
      replaceSearch(next, { replace: isFilterOnlyPatch(Object.keys(patch)) });
    },
    [replaceSearch, search],
  );

  return { search, section, patchSearch, replaceSearch };
}

/** Closed-set tab control stored in `?tab=`. Default omitted from the URL. */
export function useAdminSectionTab<const TValue extends string>(
  allowed: readonly TValue[],
  defaultTab: TValue,
  section: string,
): readonly [TValue, (tab: TValue) => void] {
  const { search, patchSearch } = useAdminSectionSearch(section);
  const tab = resolveClosedSearchParam(search.tab, allowed, defaultTab);

  const setTab = useCallback(
    (next: TValue) => {
      if (next === defaultTab) {
        patchSearch({ tab: undefined });
        return;
      }
      patchSearch({ tab: next });
    },
    [defaultTab, patchSearch],
  );

  return [tab, setTab] as const;
}
