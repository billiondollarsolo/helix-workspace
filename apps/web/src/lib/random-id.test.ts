import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when the context provides it", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it("builds a v4 UUID from getRandomValues outside secure contexts", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => array.fill(0xff),
    });
    expect(randomId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => globalThis.crypto.getRandomValues(array),
    });
  });

  it("returns distinct ids", () => {
    expect(new Set(Array.from({ length: 50 }, randomId)).size).toBe(50);
  });
});
