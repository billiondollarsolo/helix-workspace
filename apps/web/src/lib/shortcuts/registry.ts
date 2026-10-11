/* Scoped shortcut registry. Components register handlers for catalog ids
   while mounted (see use-shortcuts.ts); one window listener feeds key events
   through `handleKeyDown`, which applies, in order:

   1. the typing guard — no shortcuts while focus is in a text field or an IME
      composition is in progress, unless the shortcut allows it (Escape, ⌘Enter);
   2. the on/off preference — when off, only Ctrl/Alt/⌘ chords fire;
   3. overlay precedence — while a modal dialog or menu is open only the
      `dialog` scope (and shortcuts marked `allowInOverlay`) can fire;
   4. scope precedence — dialog, then the open conversation, then the current
      app, then global; later registrations win within a scope;
   5. Gmail-style sequences — `g` then `i` within SEQUENCE_TIMEOUT_MS. */

import {
  SHORTCUT_CATALOG,
  type ShortcutDefinition,
  type ShortcutId,
  type ShortcutScope,
} from "./catalog";
import { chordHasCommandModifier, eventChord, parseKeySequence } from "./keys";

/** Return `false` to decline the key so lower-precedence shortcuts (or the
    browser default) can handle it. */
export type ShortcutHandler = (event: KeyboardEvent) => void | false;

export const SEQUENCE_TIMEOUT_MS = 1500;

const SCOPE_PRIORITY: Readonly<Record<ShortcutScope, number>> = {
  dialog: 3,
  "mail.thread": 2,
  mail: 1,
  calendar: 1,
  drive: 1,
  chat: 1,
  contacts: 1,
  global: 0,
};

const TEXT_INPUT_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const ACTIVATING_SELECTOR =
  'button, a[href], select, summary, input, textarea, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]';

/** True when keys typed at `target` produce text, so shortcuts must stand aside. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !TEXT_INPUT_EXEMPT_TYPES.has(target.type);
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

function activatesTarget(chord: string, target: EventTarget | null): boolean {
  return (
    (chord === "enter" || chord === "space") &&
    target instanceof Element &&
    target.closest(ACTIVATING_SELECTOR) !== null
  );
}

export interface ShortcutKeyContext {
  /** The user's Keyboard shortcuts on/off preference. */
  readonly enabled: boolean;
  /** A modal dialog or menu is open. */
  readonly overlayOpen: boolean;
  readonly isMac: boolean;
  /** Event time in ms; defaults to `Date.now()`. */
  readonly now?: number;
}

interface Registration {
  readonly id: ShortcutId;
  readonly definition: ShortcutDefinition;
  readonly handler: ShortcutHandler;
  readonly order: number;
}

export interface ShortcutRegistry {
  register(entries: readonly { id: ShortcutId; handler: ShortcutHandler }[]): () => void;
  /** Dispatch a keydown. Returns true when a shortcut consumed it. */
  handleKeyDown(event: KeyboardEvent, context: ShortcutKeyContext): boolean;
}

export function createShortcutRegistry(): ShortcutRegistry {
  const registrations = new Set<Registration>();
  let nextOrder = 0;
  let pending: { readonly chord: string; readonly at: number } | null = null;

  const eligible = (event: KeyboardEvent, chord: string, context: ShortcutKeyContext) => {
    const typing = isTypingTarget(event.target);
    return [...registrations]
      .filter(({ definition }) => {
        if (context.overlayOpen && definition.scope !== "dialog" && !definition.allowInOverlay) {
          return false;
        }
        if (typing && definition.allowInInput !== true) {
          return false;
        }
        return !activatesTarget(chord, event.target);
      })
      .sort(
        (left, right) =>
          SCOPE_PRIORITY[right.definition.scope] - SCOPE_PRIORITY[left.definition.scope] ||
          right.order - left.order,
      );
  };

  const run = (
    candidates: readonly Registration[],
    sequence: readonly string[],
    event: KeyboardEvent,
    context: ShortcutKeyContext,
  ): boolean => {
    const target = sequence.join(" ");
    for (const candidate of candidates) {
      const matches = candidate.definition.keys.some(
        (spec) => parseKeySequence(spec, context.isMac).join(" ") === target,
      );
      const allowedWhenOff = sequence.length === 1 && chordHasCommandModifier(sequence[0] ?? "");
      if (!matches || (!context.enabled && !allowedWhenOff)) {
        continue;
      }
      if (candidate.handler(event) !== false) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  };

  return {
    register(entries) {
      const added = entries.map((entry) => ({
        id: entry.id,
        definition: SHORTCUT_CATALOG[entry.id],
        handler: entry.handler,
        order: nextOrder++,
      }));
      for (const registration of added) registrations.add(registration);
      return () => {
        for (const registration of added) registrations.delete(registration);
      };
    },
    handleKeyDown(event, context) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        return false;
      }
      const chord = eventChord(event);
      if (chord === null) {
        return false;
      }
      const now = context.now ?? Date.now();
      const candidates = eligible(event, chord, context);
      const prefix = pending !== null && now - pending.at <= SEQUENCE_TIMEOUT_MS ? pending : null;
      pending = null;
      if (prefix !== null && run(candidates, [prefix.chord, chord], event, context)) {
        return true;
      }
      if (run(candidates, [chord], event, context)) {
        return true;
      }
      const startsSequence =
        context.enabled &&
        candidates.some(({ definition }) =>
          definition.keys.some((spec) => {
            const sequence = parseKeySequence(spec, context.isMac);
            return sequence.length > 1 && sequence[0] === chord;
          }),
        );
      if (startsSequence) {
        pending = { chord, at: now };
        event.preventDefault();
        return true;
      }
      return false;
    },
  };
}

/** The app-wide registry used by `useShortcuts` and the global listener. */
export const shortcutRegistry = createShortcutRegistry();
