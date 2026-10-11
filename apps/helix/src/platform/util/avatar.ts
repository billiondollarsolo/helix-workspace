import { z } from "zod";

/**
 * Avatars are small inline images: a PNG, JPEG or WebP data URL of at most
 * 350,000 characters (about 256 KB decoded). They are never stored as Drive
 * objects, so they need no malware scan; the decoded bytes must still start
 * with the declared format's signature.
 */
const AVATAR_DATA_URL_MAX_LENGTH = 350_000;

const avatarDataUrlPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/u;

const signatures: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  png: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  jpeg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  webp: (bytes) =>
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Whether a value is a bounded image data URL whose bytes match its type. */
function isAvatarDataUrl(value: string): boolean {
  if (value.length > AVATAR_DATA_URL_MAX_LENGTH) return false;
  const match = avatarDataUrlPattern.exec(value);
  if (match === null) return false;
  const [, format = "", payload = ""] = match;
  return signatures[format]?.(Buffer.from(payload.slice(0, 24), "base64")) ?? false;
}

/** A stored avatar, or null when it is missing or no longer valid. */
export function safeAvatarDataUrl(value: string | null | undefined): string | null {
  return typeof value === "string" && isAvatarDataUrl(value) ? value : null;
}

export const avatarDataUrlSchema = z
  .string()
  .max(AVATAR_DATA_URL_MAX_LENGTH, "Choose an image under 256 KB.")
  .refine(isAvatarDataUrl, "Use a PNG, JPEG or WebP image.");
