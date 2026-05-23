/* Minimal HS256 JSON Web Token signer/verifier for the OnlyOffice
 * Document Server integration.
 *
 * The DS contract requires every iframe config (and every callback body)
 * to be signed with a shared secret. We hand-roll the standard
 * `header.payload.signature` form against `node:crypto` rather than pull
 * in a JWT library — the surface we need is two functions and verifying
 * a 256-bit HMAC.
 *
 * Spec ref: https://api.onlyoffice.com/editors/security */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = base64UrlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"));

export interface OnlyOfficeJwtPayload extends Record<string, unknown> {
  /** UUID of the object being edited. Lets the file/callback routes
   *  resolve the row without trusting URL params alone. */
  readonly objectId: string;
  /** Actor on whose behalf the file is being accessed. The ACL check on
   *  read uses this, not the request session — DS isn't logged in. */
  readonly actorId: string;
  readonly orgId: string;
  /** Tenant/user-display fields baked in so the editor renders the right
   *  "you are user X" attribution without a second round-trip. */
  readonly userDisplayName: string;
  /** Issued-at / expires-at (seconds since epoch). Tokens are short-lived
   *  — 60 min — to keep stolen URLs cheap. */
  readonly iat: number;
  readonly exp: number;
}

export function signOnlyOfficeJwt(
  payload: OnlyOfficeJwtPayload,
  secret: string,
): string {
  const payloadEncoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signingInput = `${HEADER}.${payloadEncoded}`;
  const signature = base64UrlEncode(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

export type JwtVerifyResult =
  | { readonly ok: true; readonly payload: OnlyOfficeJwtPayload }
  | { readonly ok: false; readonly reason: string };

/** Verify a JWT we issued. Requires the payload to carry Helix-specific
 *  fields (objectId, actorId, orgId) — used on the file/callback URL
 *  tokens, where we want strict shape enforcement. */
export function verifyOnlyOfficeJwt(token: string, secret: string): JwtVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed token" };
  }
  const [headerEncoded, payloadEncoded, signatureEncoded] = parts as [string, string, string];
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signatureEncoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return { ok: false, reason: "signature decode failure" };
  }
  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return { ok: false, reason: "signature mismatch" };
  }
  let payload: OnlyOfficeJwtPayload;
  try {
    const json = Buffer.from(payloadEncoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    payload = JSON.parse(json) as OnlyOfficeJwtPayload;
  } catch {
    return { ok: false, reason: "payload decode failure" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof payload.objectId !== "string" || typeof payload.actorId !== "string") {
    return { ok: false, reason: "payload missing objectId/actorId" };
  }
  return { ok: true, payload };
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verify a JWT signed by the shared secret WITHOUT requiring the payload
 *  to match the Helix-issued shape. Used to validate the JWT that
 *  DocumentServer signs and includes in its callback body — DS uses its
 *  own payload schema (`{ key, status, users, actions, iat, exp }`) that
 *  doesn't carry Helix's objectId/actorId. The shared signing secret is
 *  the security gate: a valid signature proves the body came from a
 *  party that knows the secret. */
export function verifyOnlyOfficeSignatureOnly(
  token: string,
  secret: string,
): { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed token" };
  }
  const [headerEncoded, payloadEncoded, signatureEncoded] = parts as [string, string, string];
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(
      signatureEncoded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
  } catch {
    return { ok: false, reason: "signature decode failure" };
  }
  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return { ok: false, reason: "signature mismatch" };
  }
  let payload: Record<string, unknown>;
  try {
    const json = Buffer.from(
      payloadEncoded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "payload decode failure" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, payload };
}
