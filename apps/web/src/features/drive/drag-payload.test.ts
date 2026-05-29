import { describe, expect, it, vi } from "vitest";
import {
  HELIX_DRIVE_ITEM_DRAG_MIME,
  parseHelixDriveItemDragData,
  setHelixDriveItemDragData,
} from "./drag-payload";

describe("Drive drag payloads", () => {
  it("sets structured and standards-based drag data for workspace items", () => {
    const data = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none" as DataTransfer["dropEffect"],
      effectAllowed: "uninitialized" as DataTransfer["effectAllowed"],
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value);
      }),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
    };

    setHelixDriveItemDragData(dataTransfer, {
      id: "file-1",
      name: 'Board update "Q4".pptx',
      href: "/open/file-1",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      app: "slides",
    });

    expect(dataTransfer.dropEffect).toBe("copy");
    expect(dataTransfer.effectAllowed).toBe("copyLink");
    expect(data.get("text/uri-list")).toMatch(/\/open\/file-1$/u);
    expect(data.get("text/plain")).toBe('Board update "Q4".pptx');
    expect(data.get("text/html")).toContain("Board update &quot;Q4&quot;.pptx");
    expect(parseHelixDriveItemDragData(dataTransfer)).toMatchObject({
      id: "file-1",
      name: 'Board update "Q4".pptx',
      href: expect.stringMatching(/\/open\/file-1$/u),
      app: "slides",
    });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      HELIX_DRIVE_ITEM_DRAG_MIME,
      expect.stringContaining('"file-1"'),
    );
  });

  it("ignores malformed custom drag payloads", () => {
    expect(
      parseHelixDriveItemDragData({
        getData: () => "{not-json",
      }),
    ).toBeNull();
  });
});
