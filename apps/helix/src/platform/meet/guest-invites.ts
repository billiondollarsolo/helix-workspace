import { createHash, timingSafeEqual } from "node:crypto";
import { getCryptoProvider } from "../crypto/index.js";

export interface MeetGuestInviteClaims {
  readonly inviteId: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly expiresAt: Date;
}

export function mintMeetGuestInviteToken(secret: string, input: MeetGuestInviteClaims): string {
  requireSecret(secret);
  const payload = Buffer.from(
    JSON.stringify({
      inviteId: input.inviteId,
      orgId: input.orgId,
      roomId: input.roomId,
      exp: Math.floor(input.expiresAt.getTime() / 1000),
    }),
  ).toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyMeetGuestInviteToken(
  secret: string,
  token: string,
  now = new Date(),
): MeetGuestInviteClaims | null {
  requireSecret(secret);
  const [payload, supplied, extra] = token.split(".");
  if (payload === undefined || supplied === undefined || extra !== undefined) return null;
  const expected = signature(secret, payload);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !isUuid(value.inviteId) ||
      !isUuid(value.orgId) ||
      !isUuid(value.roomId) ||
      typeof value.exp !== "number" ||
      !Number.isSafeInteger(value.exp) ||
      value.exp * 1000 <= now.getTime()
    ) {
      return null;
    }
    return {
      inviteId: value.inviteId,
      orgId: value.orgId,
      roomId: value.roomId,
      expiresAt: new Date(value.exp * 1000),
    };
  } catch {
    return null;
  }
}

export function meetGuestInviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function signature(secret: string, payload: string): string {
  return getCryptoProvider().hmac("sha256", secret, `helix-meet-guest-v1.${payload}`, "base64url");
}

function requireSecret(secret: string): void {
  if (secret.length < 32)
    throw new Error("Meet guest invite secret must contain at least 32 characters.");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
