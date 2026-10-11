/* Open compose windows. Any surface can call `openCompose()`; `ComposeHost`
   renders the windows docked bottom-right, newest on the left, like a
   desktop mail client. */

import { useSyncExternalStore } from "react";
import type { MailAttachment } from "../api";
import type { AddressListInput } from "./compose-fields";

export interface ComposeInit {
  readonly to?: AddressListInput;
  readonly cc?: AddressListInput;
  readonly bcc?: AddressListInput;
  readonly subject?: string;
  /** Plain-text body; `bodyHtml` wins when both are given. */
  readonly body?: string;
  readonly bodyHtml?: string;
  /** Open in plain text mode. */
  readonly plainText?: boolean;
  /** Sending address; defaults to the primary address. */
  readonly from?: string;
  readonly attachments?: readonly MailAttachment[];
  /** Resume this saved draft (from the Drafts folder or after Undo). */
  readonly draftId?: string;
  /** Send as a reply in this conversation (a popped-out or reopened reply). */
  readonly replyTo?: { readonly threadId: string; readonly messageId?: string };
  /** Send as a forward of this message, with its original attachments when asked. */
  readonly forwardOf?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly includeAttachments: boolean;
  };
}

export interface ComposeWindowState {
  readonly id: string;
  readonly init: ComposeInit;
  readonly minimized: boolean;
  readonly maximized: boolean;
}

type Listener = () => void;

let windows: readonly ComposeWindowState[] = [];
const listeners = new Set<Listener>();

function emit(next: readonly ComposeWindowState[]) {
  windows = next;
  for (const listener of listeners) listener();
}

/** Opens a compose window and returns its id. A draft that is already open is restored instead. */
export function openCompose(init: ComposeInit = {}): string {
  const existing =
    init.draftId === undefined
      ? undefined
      : windows.find((candidate) => candidate.init.draftId === init.draftId);
  if (existing !== undefined) {
    updateComposeWindow(existing.id, { minimized: false });
    return existing.id;
  }
  const id = crypto.randomUUID();
  emit([
    ...windows.map((candidate) => ({ ...candidate, maximized: false })),
    { id, init, minimized: false, maximized: false },
  ]);
  return id;
}

export function closeCompose(id: string): void {
  emit(windows.filter((candidate) => candidate.id !== id));
}

export function updateComposeWindow(
  id: string,
  patch: Partial<Pick<ComposeWindowState, "minimized" | "maximized">>,
): void {
  emit(
    windows.map((candidate) => {
      if (candidate.id === id) return { ...candidate, ...patch };
      // Only one window can be full size at a time.
      return patch.maximized === true ? { ...candidate, maximized: false } : candidate;
    }),
  );
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return windows;
}

export function useComposeWindows(): readonly ComposeWindowState[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test helper: closes every window. */
export function resetComposeWindows(): void {
  emit([]);
}
