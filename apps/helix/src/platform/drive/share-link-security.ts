import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const passwordKeyBytes = 32;
const deriveScrypt = promisify(scrypt);

/** MIME types that browsers execute in-origin; always forced to an opaque download. */
const ACTIVE_CONTENT_MIME_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

export function hashDriveShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function hashDriveSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await deriveScrypt(password, salt, passwordKeyBytes)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyDriveSharePassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, saltText, digestText] = encoded.split(":");
  if (algorithm !== "scrypt" || saltText === undefined || digestText === undefined) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = (await deriveScrypt(password, salt, expected.byteLength)) as Buffer;
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function safeDriveDownloadPolicy(input: {
  readonly mimeType: string | undefined;
  readonly requestedInline: boolean;
}): {
  readonly mimeType: string;
  readonly disposition: "attachment" | "inline";
} {
  const normalized = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    ACTIVE_CONTENT_MIME_TYPES.has(normalized)
  ) {
    return { mimeType: "application/octet-stream", disposition: "attachment" };
  }
  return {
    mimeType: normalized,
    disposition: input.requestedInline ? "inline" : "attachment",
  };
}
