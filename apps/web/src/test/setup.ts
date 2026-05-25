import { afterEach, beforeEach } from "vitest";

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
