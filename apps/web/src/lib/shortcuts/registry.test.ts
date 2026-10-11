// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShortcutRegistry,
  SEQUENCE_TIMEOUT_MS,
  type ShortcutKeyContext,
  type ShortcutRegistry,
} from "./registry";

interface PressOptions extends Partial<ShortcutKeyContext> {
  readonly target?: EventTarget;
}

function press(registry: ShortcutRegistry, init: KeyboardEventInit, options: PressOptions = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  let handled = false;
  const listener = (keyEvent: KeyboardEvent) => {
    handled = registry.handleKeyDown(keyEvent, {
      enabled: options.enabled ?? true,
      overlayOpen: options.overlayOpen ?? false,
      isMac: options.isMac ?? false,
      now: options.now ?? 0,
    });
  };
  window.addEventListener("keydown", listener);
  (options.target ?? document.body).dispatchEvent(event);
  window.removeEventListener("keydown", listener);
  return { handled, prevented: event.defaultPrevented };
}

function mount<T extends HTMLElement>(element: T): T {
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("shortcut registry", () => {
  it("runs single-key handlers and prevents the browser default", () => {
    const registry = createShortcutRegistry();
    const compose = vi.fn();
    registry.register([{ id: "mail.compose", handler: compose }]);

    expect(press(registry, { key: "c" })).toEqual({ handled: true, prevented: true });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(press(registry, { key: "v" }).handled).toBe(false);
  });

  it("stops handling once unregistered", () => {
    const registry = createShortcutRegistry();
    const compose = vi.fn();
    const unregister = registry.register([{ id: "mail.compose", handler: compose }]);
    unregister();

    expect(press(registry, { key: "c" }).handled).toBe(false);
    expect(compose).not.toHaveBeenCalled();
  });

  describe("sequences", () => {
    it("completes g then i inside the timeout", () => {
      const registry = createShortcutRegistry();
      const inbox = vi.fn();
      registry.register([{ id: "global.go-inbox", handler: inbox }]);

      expect(press(registry, { key: "g" }, { now: 1000 }).handled).toBe(true);
      expect(inbox).not.toHaveBeenCalled();
      press(registry, { key: "i" }, { now: 1000 + SEQUENCE_TIMEOUT_MS - 1 });
      expect(inbox).toHaveBeenCalledTimes(1);
    });

    it("expires the prefix after the timeout and treats the key on its own", () => {
      const registry = createShortcutRegistry();
      const inbox = vi.fn();
      const star = vi.fn();
      registry.register([
        { id: "global.go-starred", handler: inbox },
        { id: "mail.star", handler: star },
      ]);

      press(registry, { key: "g" }, { now: 0 });
      press(registry, { key: "s" }, { now: SEQUENCE_TIMEOUT_MS + 1 });
      expect(inbox).not.toHaveBeenCalled();
      expect(star).toHaveBeenCalledTimes(1);
    });

    it("falls back to the single key when the second key completes nothing", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      registry.register([
        { id: "global.go-inbox", handler: vi.fn() },
        { id: "mail.compose", handler: compose },
      ]);

      press(registry, { key: "g" });
      press(registry, { key: "c" });
      expect(compose).toHaveBeenCalledTimes(1);
    });

    it("lets Shift be pressed mid-sequence without resetting it", () => {
      const registry = createShortcutRegistry();
      const inbox = vi.fn();
      registry.register([{ id: "global.go-inbox", handler: inbox }]);

      press(registry, { key: "g" });
      press(registry, { key: "Shift", shiftKey: true });
      press(registry, { key: "i" });
      expect(inbox).toHaveBeenCalledTimes(1);
    });
  });

  describe("typing guard", () => {
    it("ignores single keys typed into inputs, textareas, and contenteditable", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      registry.register([{ id: "mail.compose", handler: compose }]);
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      const nested = document.createElement("span");
      editable.append(nested);

      for (const target of [
        mount(document.createElement("input")),
        mount(document.createElement("textarea")),
        mount(editable),
        nested,
      ]) {
        expect(press(registry, { key: "c" }, { target }).handled).toBe(false);
      }
      expect(compose).not.toHaveBeenCalled();
    });

    it("still handles keys on checkboxes and buttons", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      registry.register([{ id: "mail.compose", handler: compose }]);
      const checkbox = mount(document.createElement("input"));
      checkbox.type = "checkbox";

      press(registry, { key: "c" }, { target: checkbox });
      press(registry, { key: "c" }, { target: mount(document.createElement("button")) });
      expect(compose).toHaveBeenCalledTimes(2);
    });

    it("ignores IME composition", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      registry.register([{ id: "mail.compose", handler: compose }]);

      expect(press(registry, { key: "c", isComposing: true }).handled).toBe(false);
      expect(compose).not.toHaveBeenCalled();
    });

    it("allows explicitly permitted keys such as Escape and ⌘Enter in text fields", () => {
      const registry = createShortcutRegistry();
      const closeThread = vi.fn();
      const send = vi.fn();
      registry.register([
        { id: "chat.close-thread", handler: closeThread },
        { id: "dialog.send", handler: send },
      ]);
      const textarea = mount(document.createElement("textarea"));

      press(registry, { key: "Escape" }, { target: textarea });
      press(registry, { key: "Enter", metaKey: true }, { target: textarea, isMac: true });
      expect(closeThread).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("leaves Enter on a focused button to the button", () => {
      const registry = createShortcutRegistry();
      const open = vi.fn();
      registry.register([{ id: "mail.open", handler: open }]);

      press(registry, { key: "Enter" }, { target: mount(document.createElement("button")) });
      expect(open).not.toHaveBeenCalled();
      press(registry, { key: "Enter" });
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("skips events a component already handled", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      registry.register([{ id: "mail.compose", handler: compose }]);
      const target = mount(document.createElement("div"));
      target.addEventListener("keydown", (event) => event.preventDefault());

      press(registry, { key: "c" }, { target });
      expect(compose).not.toHaveBeenCalled();
    });
  });

  describe("precedence", () => {
    it("prefers the open conversation over the mail list", () => {
      const registry = createShortcutRegistry();
      const listNext = vi.fn();
      const olderThread = vi.fn();
      registry.register([{ id: "mail.next", handler: listNext }]);
      registry.register([{ id: "mail.thread.older", handler: olderThread }]);

      press(registry, { key: "j" });
      expect(olderThread).toHaveBeenCalledTimes(1);
      expect(listNext).not.toHaveBeenCalled();
    });

    it("falls through when a higher-precedence handler declines", () => {
      const registry = createShortcutRegistry();
      const listNext = vi.fn();
      registry.register([{ id: "mail.next", handler: listNext }]);
      registry.register([{ id: "mail.thread.older", handler: () => false }]);

      expect(press(registry, { key: "j" }).handled).toBe(true);
      expect(listNext).toHaveBeenCalledTimes(1);
    });

    it("lets open dialogs and menus override app and global shortcuts", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      const help = vi.fn();
      const send = vi.fn();
      const palette = vi.fn();
      registry.register([
        { id: "mail.compose", handler: compose },
        { id: "global.help", handler: help },
        { id: "dialog.send", handler: send },
        { id: "global.command-palette", handler: palette },
      ]);

      press(registry, { key: "c" }, { overlayOpen: true });
      press(registry, { key: "?", shiftKey: true }, { overlayOpen: true });
      press(registry, { key: "Enter", ctrlKey: true }, { overlayOpen: true });
      press(registry, { key: "k", ctrlKey: true }, { overlayOpen: true });
      expect(compose).not.toHaveBeenCalled();
      expect(help).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(palette).toHaveBeenCalledTimes(1);
    });
  });

  describe("platform modifier", () => {
    it("matches ⌘K on macOS and Ctrl+K elsewhere, not the other way round", () => {
      const registry = createShortcutRegistry();
      const palette = vi.fn();
      registry.register([{ id: "global.command-palette", handler: palette }]);

      expect(press(registry, { key: "k", metaKey: true }, { isMac: true }).handled).toBe(true);
      expect(press(registry, { key: "k", ctrlKey: true }, { isMac: true }).handled).toBe(false);
      expect(press(registry, { key: "k", ctrlKey: true }, { isMac: false }).handled).toBe(true);
      expect(press(registry, { key: "k", metaKey: true }, { isMac: false }).handled).toBe(false);
      expect(palette).toHaveBeenCalledTimes(2);
    });
  });

  describe("on/off preference", () => {
    it("silences single keys and sequences but keeps modifier chords", () => {
      const registry = createShortcutRegistry();
      const compose = vi.fn();
      const inbox = vi.fn();
      const palette = vi.fn();
      registry.register([
        { id: "mail.compose", handler: compose },
        { id: "global.go-inbox", handler: inbox },
        { id: "global.command-palette", handler: palette },
      ]);

      press(registry, { key: "c" }, { enabled: false });
      press(registry, { key: "g" }, { enabled: false });
      press(registry, { key: "i" }, { enabled: false });
      press(registry, { key: "k", ctrlKey: true }, { enabled: false });
      expect(compose).not.toHaveBeenCalled();
      expect(inbox).not.toHaveBeenCalled();
      expect(palette).toHaveBeenCalledTimes(1);
    });
  });
});
