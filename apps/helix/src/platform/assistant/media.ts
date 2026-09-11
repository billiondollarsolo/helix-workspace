const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/iu;

export function isImageFile(mimeType: string, name: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_MIME.has(mime)) return true;
  return mime === "application/octet-stream" && IMAGE_EXT.test(name);
}

export function isPdfFile(mimeType: string, name: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mime === "application/pdf" || (mime === "application/octet-stream" && /\.pdf$/iu.test(name))
  );
}

/** Canonical image MIME for vision parts; `image/jpg` and extension-only uploads become jpeg/png/gif/webp. */
export function imageMimeType(mimeType: string, name: string): string {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "image/jpg") return "image/jpeg";
  if (IMAGE_MIME.has(mime) && mime !== "application/octet-stream") return mime;
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/** Best-effort extraction of literal strings from uncompressed PDF content. */
export function extractPdfText(bytes: Uint8Array): string {
  const latin1 = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const pattern = /\((?:\\.|[^\\)]){2,}\)/gu;
  for (const match of latin1.matchAll(pattern)) {
    const raw = match[0].slice(1, -1);
    const decoded = raw
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\t/gu, "\t")
      .replace(/\\([()\\])/gu, "$1");
    if (/[\x20-\x7e]{2,}/u.test(decoded)) parts.push(decoded);
    if (parts.join(" ").length > 8_000) break;
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim().slice(0, 8_000);
}
