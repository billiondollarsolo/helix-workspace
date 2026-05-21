import { getCryptoProvider } from "../crypto/index.js";

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
  readonly now?: Date | undefined;
}

export interface MintedJitsiJwt {
  readonly token: string;
  readonly expiresAt: Date;
}

export function mintJitsiJwt(input: MintJitsiJwtInput): MintedJitsiJwt {
  if (input.secret.length === 0) {
    throw new Error("Jitsi JWT secret is required.");
  }

  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = input.ttlSeconds ?? 60 * 60;
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
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
