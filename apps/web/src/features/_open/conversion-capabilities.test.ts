import { describe, expect, it } from "vitest";
import {
  canCreateEditableCopyFromFormat,
  editableCopyUnavailableMessage,
} from "./conversion-capabilities";
import type { FormatDescriptor } from "./format-detection";

describe("conversion capabilities", () => {
  it("allows editable copies only when a server converter exists", () => {
    expect(canCreateEditableCopyFromFormat(format("pptx", "slides", true))).toBe(true);
    expect(canCreateEditableCopyFromFormat(format("odp", "slides", true))).toBe(false);
    expect(canCreateEditableCopyFromFormat(format("ppt-legacy", "slides", false))).toBe(false);

    expect(canCreateEditableCopyFromFormat(format("xlsx", "sheets", true))).toBe(true);
    expect(canCreateEditableCopyFromFormat(format("ods", "sheets", true))).toBe(true);
    expect(canCreateEditableCopyFromFormat(format("docx", "docs", true))).toBe(true);
  });

  it("uses honest copy for previewable formats without native conversion", () => {
    expect(editableCopyUnavailableMessage(format("odp", "slides", true, "ODP"))).toBe(
      "editable conversion for ODP is not available yet. Preview or download the original instead.",
    );
  });
});

function format(
  id: string,
  surface: FormatDescriptor["surface"],
  supported: boolean,
  label = id,
): FormatDescriptor {
  return { id, surface, supported, label };
}
