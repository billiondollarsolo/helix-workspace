// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { eventChord, keySequenceLabels, parseKeySequence } from "./keys";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("shortcut keys", () => {
  it("maps mod to ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(parseKeySequence("mod+k", true)).toEqual(["meta+k"]);
    expect(parseKeySequence("mod+k", false)).toEqual(["ctrl+k"]);
    expect(eventChord(key({ key: "k", metaKey: true }))).toBe("meta+k");
    expect(eventChord(key({ key: "k", ctrlKey: true }))).toBe("ctrl+k");
  });

  it("keeps Shift for letters and named keys but folds it into symbols", () => {
    expect(eventChord(key({ key: "I", shiftKey: true }))).toBe("shift+i");
    expect(parseKeySequence("shift+i", false)).toEqual(["shift+i"]);
    expect(eventChord(key({ key: "?", shiftKey: true }))).toBe("?");
    expect(eventChord(key({ key: "#", shiftKey: true }))).toBe("#");
    expect(eventChord(key({ key: "Enter", metaKey: true }))).toBe("meta+enter");
    expect(eventChord(key({ key: "ArrowUp", altKey: true }))).toBe("alt+arrowup");
  });

  it("ignores bare modifier presses", () => {
    expect(eventChord(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(eventChord(key({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("parses sequences and rejects unknown modifiers", () => {
    expect(parseKeySequence("g i", false)).toEqual(["g", "i"]);
    expect(() => parseKeySequence("hyper+k", false)).toThrow(/Unknown modifier/u);
  });

  it("formats labels for the current platform", () => {
    expect(keySequenceLabels("mod+enter", true)).toEqual(["⌘Enter"]);
    expect(keySequenceLabels("mod+enter", false)).toEqual(["Ctrl+Enter"]);
    expect(keySequenceLabels("g i", false)).toEqual(["g", "i"]);
    expect(keySequenceLabels("alt+arrowdown", false)).toEqual(["Alt+↓"]);
  });
});
