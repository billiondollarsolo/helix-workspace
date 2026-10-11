import { describe, expect, it } from "vitest";
import { cropRect, initialCrop, panCrop } from "./avatar-crop";

describe("avatar crop", () => {
  it("starts with the largest centred square", () => {
    expect(cropRect(400, 200, initialCrop(400, 200))).toEqual({ x: 100, y: 0, size: 200 });
  });

  it("zooms around the centre and never leaves the image", () => {
    expect(cropRect(400, 200, { zoom: 2, centerX: 200, centerY: 100 })).toEqual({
      x: 150,
      y: 50,
      size: 100,
    });
    expect(cropRect(400, 200, { zoom: 2, centerX: 0, centerY: 0 })).toEqual({
      x: 0,
      y: 0,
      size: 100,
    });
    expect(cropRect(400, 200, { zoom: 9, centerX: 200, centerY: 100 }).size).toBe(50);
  });

  it("pans opposite to the drag, scaled from the preview", () => {
    const crop = { zoom: 2, centerX: 200, centerY: 100 };
    // Dragging the photo right by half the preview shows more of its left side.
    expect(panCrop(400, 200, crop, 120, 0, 240).centerX).toBe(150);
    expect(panCrop(400, 200, crop, 10_000, 0, 240).centerX).toBe(50);
  });
});
