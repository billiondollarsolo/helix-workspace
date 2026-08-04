/** The React half of what the two credential-issuing sections share
 *  (`app-passwords-management.tsx` and `agent-credentials-management.tsx`).
 *
 *  `credentials-shared.ts` holds the pure helpers; a `.ts` file cannot hold
 *  JSX, and a `credentials-shared.tsx` sibling would collide with it under
 *  extension-less resolution, so the hook and the form controls live here
 *  instead. Both sections draw the same four controls — actor search, actor
 *  picker, scope textarea with its toggle row, and expiry — against the same
 *  debounced directory query, and those were byte-identical copies apart from
 *  element ids and the scope list. What genuinely differs between the two
 *  sections stays a prop: the placeholder wording, the scope vocabulary, and
 *  the option markup (flat options here, grouped optgroups there). */

import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminUsersQueryOptions, type AdminUsersListResponse } from "@/features/admin/admin-users";
import { AdminInput } from "@/features/admin/console/controls";
import { StateBanner } from "@/features/admin/console/primitives";
import { SELECT_CLASS, parseScopes, toggleScope } from "@/features/admin/credentials-shared";

export interface ActorPicker {
  /** The directory page backing both the picker and the id -> name lookup. The
   *  query itself is returned rather than a derived actor list: the two
   *  sections order, group, and read the pending flags of this page
   *  differently. */
  readonly actorsQuery: UseQueryResult<AdminUsersListResponse>;
  /** What the search box shows — updated on every keystroke. */
  readonly searchDraft: string;
  readonly onSearchChange: (value: string) => void;
}

/* The picker used to show one fixed page of 50 actors, so in a workspace of
   350 the other 300 were simply unselectable — the notice said so, which made
   it an honest dead end rather than a silent one, but a dead end either way.
   The directory search is server-side (`sections/users.tsx` uses the same
   transport), so typing here narrows across the whole workspace and any actor
   is reachable. Still one bounded page per request. */
export function useActorPicker(): ActorPicker {
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  /* House rule (helix/pacer-discipline): the delay is Pacer's, never a bare
     setTimeout. */
  const commitSearch = useDebouncedCallback(
    (value: string) => {
      setSearch(value.trim());
    },
    { wait: 300 },
  );
  const actorsQuery = useQuery(
    adminUsersQueryOptions({
      includeDisabled: false,
      ...(search.length === 0 ? {} : { query: search }),
    }),
  );

  return {
    actorsQuery,
    searchDraft,
    onSearchChange: (value: string) => {
      setSearchDraft(value);
      commitSearch(value);
    },
  };
}

/** Free-text box that narrows the directory query server-side. */
export function ActorSearchField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium" htmlFor={id}>
      Find actor
      <AdminInput
        id={id}
        type="search"
        autoComplete="off"
        placeholder="Search name, email, or ID…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** A native select over the loaded actors: a labelled form control with
 *  type-ahead and platform focus behaviour, over a request that returns one
 *  bounded page. `placeholder` is the first option's text — a disabled picker
 *  still shows it, so it has to say which reason the list is empty for — and
 *  `children` are the remaining options, flat in one section and grouped into
 *  optgroups in the other. */
export function ActorSelectField({
  id,
  describedBy,
  disabled,
  placeholder,
  value,
  onBlur,
  onChange,
  children,
}: {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly value: string;
  readonly onBlur: () => void;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium" htmlFor={id}>
      Actor
      <select
        aria-describedby={describedBy}
        className={SELECT_CLASS}
        disabled={disabled}
        id={id}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        required
        value={value}
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
    </label>
  );
}

/** Why the picker is empty or truncated, and — when the directory request
 *  itself failed — the way back. */
export function ActorNoticeBanner({
  id,
  kind,
  message,
  retryable,
  onRetry,
}: {
  readonly id: string;
  readonly kind: "loading" | "error" | "info";
  readonly message: string;
  /** The actor query is `retry: false`, and a failed directory disables the
   *  whole form — without the retry the only way out is a full page reload. */
  readonly retryable: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div id={id}>
      <StateBanner kind={kind}>
        {message}
        {retryable ? (
          <Button className="mt-2" onClick={onRetry} size="xs" type="button" variant="outline">
            <RotateCcw />
            Retry
          </Button>
        ) : null}
      </StateBanner>
    </div>
  );
}

/** Free-text scope entry plus a toggle row of the scopes worth one click.
 *  `scopes` is the vocabulary, which is per-section: an app password reaches
 *  protocol scopes, an agent credential reaches platform ones. */
export function ScopesField({
  id,
  scopes,
  scopesLabel,
  value,
  onBlur,
  onChange,
}: {
  readonly id: string;
  readonly scopes: readonly string[];
  /** Names the toggle row for assistive tech. */
  readonly scopesLabel: string;
  readonly value: string;
  readonly onBlur: () => void;
  readonly onChange: (value: string) => void;
}) {
  const selectedScopes = new Set(parseScopes(value));
  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5 text-xs font-medium" htmlFor={id}>
        Scopes
        <textarea
          className="min-h-20 rounded-md border border-input bg-input/20 px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          id={id}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          required
          value={value}
        />
      </label>
      <div className="flex flex-wrap gap-1" aria-label={scopesLabel}>
        {scopes.map((scope) => {
          const selected = selectedScopes.has(scope);
          return (
            <Button
              aria-pressed={selected}
              key={scope}
              onClick={() => onChange(toggleScope(value, scope, selected))}
              size="xs"
              type="button"
              variant={selected ? "secondary" : "outline"}
            >
              {scope}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** Optional expiry. Empty means the secret never expires on its own. */
export function ExpiresAtField({
  id,
  value,
  onBlur,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onBlur: () => void;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium" htmlFor={id}>
      Expires at
      <Input
        id={id}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        type="datetime-local"
        value={value}
      />
    </label>
  );
}
