/* The mail view lives in the URL (?folder=, ?tab=, ?label=, ?q=, ?thread=)
   so Back/Forward and shared links restore it. Other parameters on /mail,
   such as ?settings= or a compose handoff, are left untouched. */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MailFolderKey } from "./api";
import { isMailFolderKey, MAIL_TAB_IDS, type MailTabId } from "./mail-taxonomy";

interface MailUrlState {
  readonly folder: MailFolderKey;
  readonly tab: MailTabId;
  /** Label slug for a label view; folder and tab are ignored while set. */
  readonly label: string | null;
  /** The committed search query; a search looks in All Mail. */
  readonly query: string;
  readonly thread: string | null;
}

interface RawMailSearch {
  readonly folder?: unknown;
  readonly tab?: unknown;
  readonly label?: unknown;
  readonly q?: unknown;
  readonly thread?: unknown;
}

function fromSearch(search: RawMailSearch): MailUrlState {
  return {
    folder: isMailFolderKey(search.folder) ? search.folder : "inbox",
    tab: MAIL_TAB_IDS.find((tab) => tab === search.tab) ?? "primary",
    label: typeof search.label === "string" && search.label !== "" ? search.label : null,
    query: typeof search.q === "string" ? search.q : "",
    thread: typeof search.thread === "string" && search.thread !== "" ? search.thread : null,
  };
}

/** The URL parameters for a state; defaults are left out. */
export function mailSearchParams(state: MailUrlState) {
  return {
    folder: state.label === null && state.folder !== "inbox" ? state.folder : undefined,
    tab:
      state.label === null && state.folder === "inbox" && state.tab !== "primary"
        ? state.tab
        : undefined,
    label: state.label ?? undefined,
    q: state.query === "" ? undefined : state.query,
    thread: state.thread ?? undefined,
  };
}

function sameState(a: MailUrlState, b: MailUrlState): boolean {
  return (
    a.folder === b.folder &&
    a.tab === b.tab &&
    a.label === b.label &&
    a.query === b.query &&
    a.thread === b.thread
  );
}

export function useMailUrlState(): readonly [MailUrlState, (patch: Partial<MailUrlState>) => void] {
  const navigate = useNavigate();
  const search: RawMailSearch = useSearch({ strict: false });
  const fromUrl = fromSearch(search);
  const [state, setState] = useState<MailUrlState>(fromUrl);
  const stateRef = useRef(state);

  // Back/Forward or a link changed the URL: follow it.
  const { folder, tab, label, query, thread } = fromUrl;
  useEffect(() => {
    const next = { folder, tab, label, query, thread };
    if (!sameState(stateRef.current, next)) {
      stateRef.current = next;
      setState(next);
    }
  }, [folder, tab, label, query, thread]);

  const update = useCallback(
    (patch: Partial<MailUrlState>) => {
      const next = { ...stateRef.current, ...patch };
      if (sameState(stateRef.current, next)) return;
      stateRef.current = next;
      setState(next);
      void navigate({
        to: "/mail",
        search: (previous: Record<string, unknown>) => ({ ...previous, ...mailSearchParams(next) }),
      } as never);
    },
    [navigate],
  );

  return [state, update] as const;
}
