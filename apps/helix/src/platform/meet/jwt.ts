import { getCryptoProvider } from "../crypto/index.js";

/** Default short-lived room JWT lifetime (MT.3): 15 minutes. */
export const DEFAULT_JITSI_JWT_TTL_SECONDS = 15 * 60;
/** Hard ceiling for mint TTL regardless of caller request (1 hour). */
export const MAX_JITSI_JWT_TTL_SECONDS = 60 * 60;
/** Minimum allowed TTL (30 seconds) so clock skew does not mint already-expired tokens. */
export const MIN_JITSI_JWT_TTL_SECONDS = 30;

export interface JitsiJwtUser {
  readonly id: string;
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly avatar?: string | undefined;
  readonly moderator?: boolean | undefined;
}

export interface MintJitsiJwtInput {
  readonly secret: string;
  readonly issuer: string;
  readonly audience?: string | undefined;
  readonly subject?: string | undefined;
  readonly room: string;
  readonly user: JitsiJwtUser;
  readonly ttlSeconds?: number | undefined;
  /** Optional override of the hard TTL ceiling (defaults to {@link MAX_JITSI_JWT_TTL_SECONDS}). */
  readonly maxTtlSeconds?: number | undefined;
  readonly now?: Date | undefined;
}

export interface MintedJitsiJwt {
  readonly token: string;
  readonly expiresAt: Date;
  readonly ttlSeconds: number;
}

export function resolveJitsiJwtTtlSeconds(input: {
  readonly ttlSeconds?: number | undefined;
  readonly maxTtlSeconds?: number | undefined;
}): number {
  const maxTtl = input.maxTtlSeconds ?? MAX_JITSI_JWT_TTL_SECONDS;
  if (!Number.isSafeInteger(maxTtl) || maxTtl < MIN_JITSI_JWT_TTL_SECONDS) {
    throw new Error(
      `Jitsi JWT maxTtlSeconds must be an integer >= ${MIN_JITSI_JWT_TTL_SECONDS}.`,
    );
  }
  const requested = input.ttlSeconds ?? DEFAULT_JITSI_JWT_TTL_SECONDS;
  if (!Number.isSafeInteger(requested) || requested < MIN_JITSI_JWT_TTL_SECONDS) {
    throw new Error(
      `Jitsi JWT ttlSeconds must be an integer >= ${MIN_JITSI_JWT_TTL_SECONDS}.`,
    );
  }
  return Math.min(requested, maxTtl);
}

export function mintJitsiJwt(input: MintJitsiJwtInput): MintedJitsiJwt {
  if (input.secret.length === 0) {
    throw new Error("Jitsi JWT secret is required.");
  }

  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = resolveJitsiJwtTtlSeconds({
    ttlSeconds: input.ttlSeconds,
    maxTtlSeconds: input.maxTtlSeconds,
  });
  const expiresAtSeconds = issuedAt + ttlSeconds;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    aud: input.audience ?? "jitsi",
    iss: input.issuer,
    sub: input.subject ?? "*",
    room: input.room,
    iat: issuedAt,
    nbf: issuedAt - 5,
    exp: expiresAtSeconds,
    context: {
      user: {
        id: input.user.id,
        name: input.user.name ?? input.user.id,
        email: input.user.email ?? "",
        avatar: input.user.avatar ?? "",
        moderator: input.user.moderator ?? false,
      },
    },
  };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signature = getCryptoProvider().hmac(
    "sha256",
    input.secret,
    `${encodedHeader}.${encodedPayload}`,
    "base64url",
  );

  return {
    token: `${encodedHeader}.${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAtSeconds * 1000),
    ttlSeconds,
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
