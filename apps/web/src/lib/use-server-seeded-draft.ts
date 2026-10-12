import { useCallback, useState, type SetStateAction } from "react";

interface DraftEdit<TServer, TDraft> {
  /** The draft this edit is measured against: the server seed it started from, or what was last saved. */
  readonly base: TDraft;
  /** The server value `base` corresponds to. */
  readonly source: TServer;
  readonly draft: TDraft;
}

interface DraftState<TServer, TDraft> {
  readonly source: TServer;
  readonly seed: TDraft;
  /** True once a defined server value has been seeded; edits made before that do not survive it. */
  readonly loaded: boolean;
  readonly edit: DraftEdit<TServer, TDraft> | null;
}

export interface ServerSeededDraft<TDraft> {
  /** What the form renders and edits. */
  readonly draft: TDraft;
  /** What the draft is being compared against: the server value it was seeded from, or the last save. */
  readonly baseline: TDraft;
  readonly isDirty: boolean;
  readonly setDraft: (update: SetStateAction<TDraft>) => void;
  /** Discard unsaved edits and follow the latest server value again. */
  readonly reset: () => void;
  /** Call after this form's own save succeeds, with the draft that was submitted. The next server
   * value re-seeds the form unless it has been edited again since that submit. */
  readonly markSaved: (submitted: TDraft) => void;
}

function isDirty<TServer, TDraft>(edit: DraftEdit<TServer, TDraft> | null): boolean {
  return edit !== null && !Object.is(edit.draft, edit.base);
}

/** A clean edit only stands while the server still matches the value it was based on. */
function activeEdit<TServer, TDraft>(
  state: DraftState<TServer, TDraft>,
): DraftEdit<TServer, TDraft> | null {
  const { edit } = state;
  if (edit === null) return null;
  return isDirty(edit) || Object.is(edit.source, state.source) ? edit : null;
}

/**
 * Local, editable form state seeded from server (query) data.
 *
 * Refetches — window focus, polling, realtime invalidation, a sibling section's
 * save — must never wipe what someone is typing. So the draft follows the
 * server value only while it has no unsaved edits; once edited, later server
 * values are held back until the edit is saved (`markSaved`) or discarded
 * (`reset`). `undefined` means "not loaded yet": the first defined server value
 * always seeds the form.
 *
 * Dirtiness is by identity (`Object.is`) against the baseline, so primitive
 * drafts become clean again when typed back to their saved value. `TDraft` must
 * not be a function. `toDraft` runs only when the server value changes, so it
 * may be an inline arrow and may mint fresh row keys.
 */
export function useServerSeededDraft<TServer, TDraft>(
  serverValue: TServer,
  toDraft: (value: TServer) => TDraft,
): ServerSeededDraft<TDraft> {
  const [state, setState] = useState<DraftState<TServer, TDraft>>(() => ({
    source: serverValue,
    seed: toDraft(serverValue),
    loaded: serverValue !== undefined,
    edit: null,
  }));

  let current = state;
  if (!Object.is(state.source, serverValue)) {
    // Adjusting state while rendering (not in an effect) so a refetch never
    // paints one frame of stale draft over the new seed, or vice versa.
    current = {
      source: serverValue,
      seed: toDraft(serverValue),
      loaded: state.loaded || serverValue !== undefined,
      edit: state.loaded && isDirty(state.edit) ? state.edit : null,
    };
    setState(current);
  }

  const setDraft = useCallback((update: SetStateAction<TDraft>) => {
    setState((prev) => {
      const active = activeEdit(prev);
      const from = active === null ? prev.seed : active.draft;
      const next =
        typeof update === "function" ? (update as (previous: TDraft) => TDraft)(from) : update;
      const edit = active ?? { base: prev.seed, source: prev.source };
      return { ...prev, edit: { base: edit.base, source: edit.source, draft: next } };
    });
  }, []);

  const reset = useCallback(() => {
    setState((prev) => (prev.edit === null ? prev : { ...prev, edit: null }));
  }, []);

  const markSaved = useCallback((submitted: TDraft) => {
    // Rebasing onto the submitted draft makes the edit clean unless it was
    // typed into since. If the save's own refetch already landed (and was held
    // back), a clean edit no longer matches the server and the form follows
    // it now; otherwise the next server value re-seeds it.
    setState((prev) => {
      const active = activeEdit(prev);
      return active === null ? prev : { ...prev, edit: { ...active, base: submitted } };
    });
  }, []);

  const edit = activeEdit(current);
  return {
    draft: edit === null ? current.seed : edit.draft,
    baseline: edit === null ? current.seed : edit.base,
    isDirty: isDirty(edit),
    setDraft,
    reset,
    markSaved,
  };
}
