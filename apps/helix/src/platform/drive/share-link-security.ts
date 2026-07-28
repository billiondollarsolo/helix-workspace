import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const passwordKeyBytes = 32;

export function hashDriveShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashDriveSharePassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, passwordKeyBytes);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export function verifyDriveSharePassword(password: string, encoded: string): boolean {
  const [algorithm, saltText, digestText] = encoded.split(":");
  if (algorithm !== "scrypt" || saltText === undefined || digestText === undefined) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = scryptSync(password, salt, expected.byteLength);
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
  const active = new Set([
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
  ]);
  if (normalized === undefined || normalized.length === 0 || active.has(normalized)) {
    return { mimeType: "application/octet-stream", disposition: "attachment" };
  }
  return {
    mimeType: normalized,
    disposition: input.requestedInline ? "inline" : "attachment",
  };
}
