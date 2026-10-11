/* The Helix keyboard shortcut catalog — the single source of truth for every
   shortcut the workspace handles. The `?` help dialog and Settings → Keyboard
   shortcuts render from this list, so it must only contain shortcuts whose
   handler is wired with `useShortcuts` (enforced by catalog-wiring.test.ts).

   To add a shortcut: add an entry here, then call
   `useShortcuts(scope, { "<id>": handler })` in the component that owns the
   action. */

const SHORTCUT_SCOPES = [
  "global",
  "mail",
  "mail.thread",
  "calendar",
  "drive",
  "chat",
  "dialog",
] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

const SHORTCUT_SCOPE_LABELS: Readonly<Record<ShortcutScope, string>> = {
  global: "Anywhere",
  mail: "Mail",
  "mail.thread": "Open conversation",
  calendar: "Calendar",
  drive: "Drive",
  chat: "Chat",
  dialog: "Compose and dialogs",
};

export interface ShortcutDefinition {
  readonly scope: ShortcutScope;
  /** Alternative key specs; each may be a sequence such as `"g i"`. */
  readonly keys: readonly string[];
  readonly description: string;
  /** Fire even while focus is in a text field (Escape, ⌘Enter, Alt+arrows). */
  readonly allowInInput?: boolean;
  /** Fire even while a modal dialog or menu is open. */
  readonly allowInOverlay?: boolean;
}

export const SHORTCUT_CATALOG = {
  "global.help": { scope: "global", keys: ["?"], description: "Show keyboard shortcuts" },
  "global.command-palette": {
    scope: "global",
    keys: ["mod+k"],
    description: "Open or close the command palette",
    allowInInput: true,
    allowInOverlay: true,
  },
  "global.focus-search": { scope: "global", keys: ["/"], description: "Search the current app" },
  "global.go-inbox": { scope: "global", keys: ["g i"], description: "Go to Mail inbox" },
  "global.go-starred": { scope: "global", keys: ["g s"], description: "Go to starred mail" },
  "global.go-sent": { scope: "global", keys: ["g t"], description: "Go to sent mail" },
  "global.go-drafts": { scope: "global", keys: ["g d"], description: "Go to drafts" },
  "global.go-calendar": { scope: "global", keys: ["g c"], description: "Go to Calendar" },
  "global.go-chat": { scope: "global", keys: ["g k"], description: "Go to Chat" },
  "global.go-drive": { scope: "global", keys: ["g r"], description: "Go to Drive" },
  "global.go-meet": { scope: "global", keys: ["g h"], description: "Go to Meet" },

  "mail.compose": { scope: "mail", keys: ["c"], description: "Compose a new message" },
  "mail.next": { scope: "mail", keys: ["j"], description: "Move to the next conversation" },
  "mail.previous": {
    scope: "mail",
    keys: ["k"],
    description: "Move to the previous conversation",
  },
  "mail.open": { scope: "mail", keys: ["o", "enter"], description: "Open the conversation" },
  "mail.select": { scope: "mail", keys: ["x"], description: "Select the conversation" },
  "mail.star": { scope: "mail", keys: ["s"], description: "Star or unstar" },
  "mail.archive": { scope: "mail", keys: ["e"], description: "Archive" },
  "mail.delete": { scope: "mail", keys: ["#"], description: "Move to trash" },
  "mail.spam": { scope: "mail", keys: ["!"], description: "Report spam" },
  "mail.mark-read": { scope: "mail", keys: ["shift+i"], description: "Mark as read" },
  "mail.mark-unread": { scope: "mail", keys: ["shift+u"], description: "Mark as unread" },

  "mail.thread.older": {
    scope: "mail.thread",
    keys: ["j"],
    description: "Open the older conversation",
  },
  "mail.thread.newer": {
    scope: "mail.thread",
    keys: ["k"],
    description: "Open the newer conversation",
  },
  "mail.thread.back": {
    scope: "mail.thread",
    keys: ["u"],
    description: "Back to the conversation list",
  },
  "mail.thread.reply": { scope: "mail.thread", keys: ["r"], description: "Reply" },
  "mail.thread.reply-all": { scope: "mail.thread", keys: ["a"], description: "Reply all" },
  "mail.thread.forward": { scope: "mail.thread", keys: ["f"], description: "Forward" },

  "calendar.view-day": { scope: "calendar", keys: ["d"], description: "Day view" },
  "calendar.view-3day": { scope: "calendar", keys: ["x"], description: "3-day view" },
  "calendar.view-week": { scope: "calendar", keys: ["w"], description: "Week view" },
  "calendar.view-month": { scope: "calendar", keys: ["m"], description: "Month view" },
  "calendar.view-schedule": { scope: "calendar", keys: ["a"], description: "Schedule view" },
  "calendar.today": { scope: "calendar", keys: ["t"], description: "Jump to today" },
  "calendar.next": { scope: "calendar", keys: ["j", "n"], description: "Next period" },
  "calendar.previous": { scope: "calendar", keys: ["k", "p"], description: "Previous period" },
  "calendar.create": { scope: "calendar", keys: ["c"], description: "Create an event" },
  "calendar.edit": { scope: "calendar", keys: ["e"], description: "Edit the open event" },
  "calendar.delete": {
    scope: "calendar",
    keys: ["delete", "backspace"],
    description: "Delete the open event",
  },
  "calendar.close": {
    scope: "calendar",
    keys: ["escape"],
    description: "Close the open event or editor",
    allowInInput: true,
  },

  "drive.new-folder": { scope: "drive", keys: ["n"], description: "New folder" },
  "drive.upload": { scope: "drive", keys: ["shift+u"], description: "Upload a file" },
  "drive.trash": {
    scope: "drive",
    keys: ["delete", "backspace"],
    description: "Move the selected file to trash",
  },

  "chat.close-thread": {
    scope: "chat",
    keys: ["escape"],
    description: "Close the open thread",
    allowInInput: true,
  },
  "chat.previous-conversation": {
    scope: "chat",
    keys: ["alt+arrowup"],
    description: "Previous space or direct message",
    allowInInput: true,
  },
  "chat.next-conversation": {
    scope: "chat",
    keys: ["alt+arrowdown"],
    description: "Next space or direct message",
    allowInInput: true,
  },

  "dialog.send": {
    scope: "dialog",
    keys: ["mod+enter"],
    description: "Send the message you are composing",
    allowInInput: true,
  },
} as const satisfies Readonly<Record<string, ShortcutDefinition>>;

export type ShortcutId = keyof typeof SHORTCUT_CATALOG;

/** Shortcut ids that belong to `S`. */
export type ShortcutIdIn<S extends ShortcutScope> = {
  [K in ShortcutId]: (typeof SHORTCUT_CATALOG)[K]["scope"] extends S ? K : never;
}[ShortcutId];

/** Catalog entries grouped by scope, in scope display order. */
export function shortcutGroups(): readonly {
  readonly scope: ShortcutScope;
  readonly label: string;
  readonly shortcuts: readonly (ShortcutDefinition & { readonly id: ShortcutId })[];
}[] {
  const catalog: Readonly<Record<ShortcutId, ShortcutDefinition>> = SHORTCUT_CATALOG;
  const entries = (Object.keys(catalog) as ShortcutId[]).map((id) => ({ id, ...catalog[id] }));
  return SHORTCUT_SCOPES.map((scope) => ({
    scope,
    label: SHORTCUT_SCOPE_LABELS[scope],
    shortcuts: entries.filter((entry) => entry.scope === scope),
  })).filter((group) => group.shortcuts.length > 0);
}
