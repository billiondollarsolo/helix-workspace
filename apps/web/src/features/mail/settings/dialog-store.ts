/* Which mail settings dialog is open. Any surface opens one with the
   functions below; `MailDialogsHost` (mounted once by the app shell)
   renders it, so callers never mount dialogs themselves. */

import { useSyncExternalStore } from "react";
import type { MailFilterRecord } from "../api";

/** Starting criteria for a new filter, e.g. from "Filter messages like these". */
export interface MailFilterPrefill {
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly hasWords?: string;
  readonly hasAttachment?: boolean;
}

export type MailLabelDialogRequest =
  | {
      readonly mode: "create";
      /** Pre-select "Nest label under" this label. */
      readonly parentId?: string | null;
    }
  | { readonly mode: "edit"; readonly labelId: string };

export type MailDialogRequest =
  | { readonly kind: "filter"; readonly prefill: MailFilterPrefill }
  | { readonly kind: "filter-edit"; readonly filter: MailFilterRecord }
  | { readonly kind: "filter-remove"; readonly filter: MailFilterRecord }
  | { readonly kind: "label"; readonly request: MailLabelDialogRequest }
  | { readonly kind: "label-remove"; readonly labelId: string };

/** `seq` changes on every open, so a new request starts a fresh dialog. */
interface OpenMailDialog {
  readonly seq: number;
  readonly request: MailDialogRequest;
}

let current: OpenMailDialog | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function show(request: MailDialogRequest | null): void {
  seq += 1;
  current = request === null ? null : { seq, request };
  for (const listener of listeners) listener();
}

/** Opens the two-step filter dialog with the given criteria filled in. */
export function openFilterDialog(prefill: MailFilterPrefill = {}): void {
  show({ kind: "filter", prefill });
}

/** Opens the filter dialog to edit a saved filter. */
export function openFilterEditor(filter: MailFilterRecord): void {
  show({ kind: "filter-edit", filter });
}

/** Asks to confirm deleting a saved filter. */
export function openRemoveFilterDialog(filter: MailFilterRecord): void {
  show({ kind: "filter-remove", filter });
}

/** Opens the new-label dialog, or the edit dialog for `labelId`. */
export function openLabelDialog(request: MailLabelDialogRequest): void {
  show({ kind: "label", request });
}

/** Asks to confirm removing a label and the labels nested under it. */
export function openRemoveLabelDialog(labelId: string): void {
  show({ kind: "label-remove", labelId });
}

export function closeMailDialog(): void {
  show(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenMailDialog(): OpenMailDialog | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
