import { Store } from "@tanstack/store";
import { useSyncExternalStore } from "react";

export type MailDensity = "comfortable" | "compact";

export interface MailComposerRecipient {
  readonly name: string;
  readonly email: string;
}

export interface MailComposerDraft {
  readonly mode: "new" | "reply";
  readonly threadId?: string;
  readonly to: readonly MailComposerRecipient[];
  readonly cc: readonly MailComposerRecipient[];
  readonly bcc: readonly MailComposerRecipient[];
  readonly subject: string;
  readonly body: string;
}

interface MailUiState {
  readonly density: MailDensity;
  readonly selectedMessageIds: readonly string[];
  readonly selectedThreadIds: readonly string[];
  readonly composerDraft: MailComposerDraft | null;
}

const storageKey = "helix-mail-ui";

function readInitialDensity(): MailDensity {
  if (typeof window === "undefined") {
    return "comfortable";
  }
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) {
      return "comfortable";
    }
    const parsed = JSON.parse(stored) as Partial<MailUiState>;
    return parsed.density === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function persistDensity(density: MailDensity) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ density }));
  } catch {
    // Mail density remains usable in memory if storage is unavailable.
  }
}

const initialMailUiState: MailUiState = {
  density: readInitialDensity(),
  selectedMessageIds: [],
  selectedThreadIds: [],
  composerDraft: null,
};

export const mailUiStore = new Store<MailUiState>(initialMailUiState);

export function useMailUiStore<T>(selector: (state: MailUiState) => T): T {
  return useSyncExternalStore(
    (onStoreChange) => {
      const subscription = mailUiStore.subscribe(onStoreChange);
      return () => subscription.unsubscribe();
    },
    () => selector(mailUiStore.state),
    () => selector(mailUiStore.state),
  );
}

export function setMailDensity(density: MailDensity) {
  persistDensity(density);
  mailUiStore.setState((state) => ({
    ...state,
    density,
  }));
}

export function toggleSelectedMailThread(threadId: string) {
  mailUiStore.setState((state) => {
    const selectedThreadIds = state.selectedThreadIds.includes(threadId)
      ? state.selectedThreadIds.filter((selectedId) => selectedId !== threadId)
      : [...state.selectedThreadIds, threadId];
    return {
      ...state,
      selectedThreadIds,
    };
  });
}

export function toggleSelectedMailMessage(messageId: string) {
  mailUiStore.setState((state) => {
    const selectedMessageIds = state.selectedMessageIds.includes(messageId)
      ? state.selectedMessageIds.filter((selectedId) => selectedId !== messageId)
      : [...state.selectedMessageIds, messageId];
    return {
      ...state,
      selectedMessageIds,
    };
  });
}

export function setMailComposerDraft(draft: MailComposerDraft | null) {
  mailUiStore.setState((state) => ({
    ...state,
    composerDraft: draft,
  }));
}

export function updateMailComposerDraft(partial: Partial<MailComposerDraft>) {
  mailUiStore.setState((state) => {
    if (state.composerDraft === null) {
      return state;
    }
    return {
      ...state,
      composerDraft: {
        ...state.composerDraft,
        ...partial,
      },
    };
  });
}

export function resetMailUiStoreForTest() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(storageKey);
  }
  mailUiStore.setState(() => ({
    density: "comfortable",
    selectedMessageIds: [],
    selectedThreadIds: [],
    composerDraft: null,
  }));
}
