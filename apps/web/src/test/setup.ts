import { afterEach, beforeAll, beforeEach } from "vitest";

// `@tanstack/react-virtual` queries the scroll container's clientHeight,
// scrollHeight, and offsetHeight to size the virtual window. jsdom returns
// 0 for all of those by default, which collapses the virtualizer to zero
// rendered rows and breaks every test that relies on virtualized content.
// Set the layout properties up-front so the virtualizer believes the
// container has a normal 800x600 viewport and renders its overscan window.
function installVirtualizerLayoutShims(): void {
  if (typeof window === "undefined") {
    return;
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  if (desc?.get?.toString().includes("HELIX_TEST_LAYOUT")) {
    return;
  }
  const define = (
    prop: "offsetHeight" | "offsetWidth" | "clientHeight" | "clientWidth" | "scrollHeight",
    value: number,
  ) => {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: function HELIX_TEST_LAYOUT(this: HTMLElement) {
        return value;
      },
    });
  };
  define("offsetHeight", 600);
  define("clientHeight", 600);
  define("offsetWidth", 800);
  define("clientWidth", 800);
  define("scrollHeight", 600);

  window.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

function hasUsableLocalStorage(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const storage = window.localStorage;
    return (
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function" &&
      typeof storage.clear === "function"
    );
  } catch {
    return false;
  }
}

function installMemoryLocalStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeAll(() => {
  installVirtualizerLayoutShims();
});

beforeEach(() => {
  if (!hasUsableLocalStorage()) {
    installMemoryLocalStorage();
  }
});

afterEach(() => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.clear();
  } catch {
    installMemoryLocalStorage();
  }
});
