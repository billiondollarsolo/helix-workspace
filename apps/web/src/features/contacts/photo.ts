/* Contact pictures are stored inline in the vCard, so the form shrinks a
   chosen picture to a small square JPEG before saving it. */

const SIZE = 256;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export async function contactPictureDataUrl(file: File): Promise<string> {
  if (!/^image\/(?:png|jpeg|webp|gif)$/u.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP or GIF picture.");
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Choose a picture smaller than 10 MB.");
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot prepare the picture.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
