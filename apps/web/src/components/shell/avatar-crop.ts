/* Square crop maths and encoding for profile photos. The crop is a square
   window over the image: zoom 1 fits the shorter side, and the centre can
   move only as far as keeps the window inside the image. */

/** Profile photos are stored at this size (pixels per side). */
const AVATAR_SIZE = 256;
/** Matches the server's limit on the stored data URL. */
const AVATAR_MAX_DATA_URL_LENGTH = 350_000;
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

export interface CropState {
  /** 1 (fit) to 4. */
  readonly zoom: number;
  /** Centre of the crop window, in image pixels. */
  readonly centerX: number;
  readonly centerY: number;
}

export interface SourceRect {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export function initialCrop(width: number, height: number): CropState {
  return { zoom: 1, centerX: width / 2, centerY: height / 2 };
}

/** The image region the crop window covers, kept inside the image. */
export function cropRect(width: number, height: number, crop: CropState): SourceRect {
  const zoom = Math.min(4, Math.max(1, crop.zoom));
  const size = Math.min(width, height) / zoom;
  const half = size / 2;
  const centerX = Math.min(width - half, Math.max(half, crop.centerX));
  const centerY = Math.min(height - half, Math.max(half, crop.centerY));
  return { x: centerX - half, y: centerY - half, size };
}

/** Move the window by a screen-space delta seen in a preview `previewSize` wide. */
export function panCrop(
  width: number,
  height: number,
  crop: CropState,
  deltaX: number,
  deltaY: number,
  previewSize: number,
): CropState {
  const rect = cropRect(width, height, crop);
  const scale = rect.size / previewSize;
  const moved = cropRect(width, height, {
    ...crop,
    centerX: rect.x + rect.size / 2 - deltaX * scale,
    centerY: rect.y + rect.size / 2 - deltaY * scale,
  });
  return { ...crop, centerX: moved.x + moved.size / 2, centerY: moved.y + moved.size / 2 };
}

/** Draw the crop at AVATAR_SIZE and encode it small enough to store. */
export function encodeAvatar(image: CanvasImageSource, rect: SourceRect): string {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot resize images.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, rect.x, rect.y, rect.size, rect.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= AVATAR_MAX_DATA_URL_LENGTH) return url;
  }
  throw new Error("This photo is too detailed to store. Try a simpler image.");
}
