/* Key parsing, event normalization, and display for the shortcut registry.

   A key spec is one or more space-separated chords: `"c"`, `"shift+i"`,
   `"mod+enter"`, `"alt+arrowup"`, `"g i"`. `mod` is ⌘ on Apple platforms and
   Ctrl elsewhere. Letters keep Shift as an explicit modifier (`shift+i` is
   Shift+I); symbols such as `?`, `#`, and `!` already encode Shift in the
   produced character, so Shift is ignored for them. */

const MODIFIER_ORDER = ["ctrl", "alt", "meta", "shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "OS"]);

/** True when `mod` should mean ⌘ (macOS, iPadOS, iOS). */
export function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const withHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = withHints.userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/iu.test(platform);
}

function normalizeKeyName(key: string): string {
  if (key === " ") {
    return "space";
  }
  if (key === "Esc") {
    return "escape";
  }
  return key.toLowerCase();
}

function isLetter(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase();
}

function canonicalChord(modifiers: ReadonlySet<Modifier>, key: string): string {
  const keepShift = key.length > 1 || isLetter(key);
  const parts = MODIFIER_ORDER.filter(
    (modifier) => modifiers.has(modifier) && (modifier !== "shift" || keepShift),
  );
  return [...parts, key].join("+");
}

/** Parse one chord spec (`"mod+shift+k"`) into its canonical form. */
function parseChord(spec: string, isMac: boolean): string {
  const tokens = spec.toLowerCase().split("+");
  const key = tokens.pop();
  if (key === undefined || key === "") {
    throw new Error(`Invalid shortcut chord "${spec}".`);
  }
  const modifiers = new Set<Modifier>();
  for (const token of tokens) {
    if (token === "mod") {
      modifiers.add(isMac ? "meta" : "ctrl");
    } else if ((MODIFIER_ORDER as readonly string[]).includes(token)) {
      modifiers.add(token as Modifier);
    } else {
      throw new Error(`Unknown modifier "${token}" in shortcut "${spec}".`);
    }
  }
  return canonicalChord(modifiers, normalizeKeyName(key));
}

/** Parse a key spec into its canonical chord sequence. */
export function parseKeySequence(spec: string, isMac: boolean): readonly string[] {
  return spec
    .trim()
    .split(/\s+/u)
    .map((chord) => parseChord(chord, isMac));
}

/** Canonical chord for a keyboard event, or null for a bare modifier press. */
export function eventChord(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === "Dead" || event.key === "Unidentified") {
    return null;
  }
  const modifiers = new Set<Modifier>();
  if (event.ctrlKey) modifiers.add("ctrl");
  if (event.altKey) modifiers.add("alt");
  if (event.metaKey) modifiers.add("meta");
  if (event.shiftKey) modifiers.add("shift");
  return canonicalChord(modifiers, normalizeKeyName(event.key));
}

/** True when the chord carries Ctrl, Alt, or ⌘ — these survive the on/off switch. */
export function chordHasCommandModifier(chord: string): boolean {
  return /(?:^|\+)(?:ctrl|alt|meta)\+/u.test(chord);
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
  delete: "Delete",
  backspace: "Backspace",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

function chordLabel(chord: string, isMac: boolean): string {
  const tokens = chord.split("+");
  const key = tokens.pop() ?? "";
  const labels = tokens.map((modifier) => {
    if (modifier === "meta") return isMac ? "⌘" : "Win";
    if (modifier === "ctrl") return isMac ? "⌃" : "Ctrl";
    if (modifier === "alt") return isMac ? "⌥" : "Alt";
    return isMac ? "⇧" : "Shift";
  });
  const keyLabel =
    KEY_LABELS[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1));
  return [...labels, keyLabel].join(isMac ? "" : "+");
}

/** Human labels for a key spec: one entry per chord in the sequence. */
export function keySequenceLabels(spec: string, isMac: boolean): readonly string[] {
  return parseKeySequence(spec, isMac).map((chord) => chordLabel(chord, isMac));
}
