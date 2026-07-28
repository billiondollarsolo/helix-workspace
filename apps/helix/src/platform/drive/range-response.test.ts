import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "./range-response.js";

describe("parseRangeHeader", () => {
  it("parses bytes=0-99", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });
  it("parses open-ended bytes=500-", () => {
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });
  it("parses suffix bytes=-200", () => {
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });
  it("clamps end past total", () => {
    expect(parseRangeHeader("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  });
  it("marks multi-range unsupported", () => {
    expect(parseRangeHeader("bytes=0-10,20-30", 1000)).toBe("unsupported");
  });
  it("marks start>=total invalid", () => {
    expect(parseRangeHeader("bytes=1000-1001", 1000)).toBe("invalid");
  });
  it("marks total=0 invalid", () => {
    expect(parseRangeHeader("bytes=0-0", 0)).toBe("invalid");
  });
  it("marks garbage invalid", () => {
    expect(parseRangeHeader("chunks=0-1", 1000)).toBe("invalid");
  });
});
