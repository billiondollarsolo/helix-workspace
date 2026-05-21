import { getCryptoProvider } from "../crypto/index.js";

/**
 * Expanded agent credential model (PRD §9.2).
 *
 * The original model recognised only `oauth_client` credentials. This module
 * adds `api_key` and `mtls_cert` credential types and the per-credential
 * policy fields (`ip_allowlist`, `allowed_hours`, `confirmation_override`,
 * `rate_limit_overrides`) together with the request-path enforcement that
 * makes them effective.
 */

export type AgentCredentialType = "oauth_client" | "api_key" | "mtls_cert";

/**
 * Per-credential override for the tier confirmation gate. `"always"` forces
 * every side-effecting tool through confirmation regardless of tier defaults;
 * `"never"` bypasses confirmation; `"inherit"` (the default when the field is
 * absent) leaves the tier behaviour unchanged.
 */
export type ConfirmationOverride = "always" | "never" | "inherit";

/**
 * Per-credential rate / cost limit overrides. Any field left undefined falls
 * back to the tier budget. `null` explicitly removes a limit.
 */
export interface RateLimitOverrides {
  readonly requestsPerMinute?: number | null;
  readonly requestsPerDay?: number | null;
  readonly costPerDayUsdMicros?: number | null;
}

/**
 * An allowed-hours window. Hours are 0-23 in the given IANA `timeZone` (UTC
 * when omitted). `days` restricts to days of the week (0 = Sunday). The window
 * may wrap past midnight (e.g. 22-06).
 */
export interface AllowedHoursWindow {
  readonly startHour: number;
  readonly endHour: number;
  readonly timeZone?: string;
  readonly days?: readonly number[];
}

export interface AgentCredentialPolicy {
  readonly ipAllowlist: readonly string[];
  readonly allowedHours: AllowedHoursWindow | null;
  readonly confirmationOverride: ConfirmationOverride;
  readonly rateLimitOverrides: RateLimitOverrides;
}

export interface AgentCredentialRecord {
  readonly id: string;
  readonly credentialType: AgentCredentialType;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  /** Present for `oauth_client` credentials. */
  readonly clientId: string | null;
  /** Present for `oauth_client` credentials (PHC argon2id hash). */
  readonly secretHash: string | null;
  /** Present for `api_key` credentials (SHA-256 hex of the key). */
  readonly apiKeyHash: string | null;
  /** Present for `mtls_cert` credentials (lowercase hex SHA-256 fingerprint). */
  readonly certFingerprint: string | null;
  readonly label: string | null;
  readonly policy: AgentCredentialPolicy;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export const EMPTY_CREDENTIAL_POLICY: AgentCredentialPolicy = {
  ipAllowlist: [],
  allowedHours: null,
  confirmationOverride: "inherit",
  rateLimitOverrides: {},
};

// --- credential store -------------------------------------------------------

export interface AgentCredentialStore {
  findByApiKeyHash(apiKeyHash: string): Promise<AgentCredentialRecord | null>;
  findByCertFingerprint(fingerprint: string): Promise<AgentCredentialRecord | null>;
}

// --- API key hashing --------------------------------------------------------

const API_KEY_PREFIX = "helix_ak_";

/** Generate a fresh, opaque API key. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${getCryptoProvider().randomBytes(32).toString("base64url")}`;
}

/** Hash an API key for storage / lookup (SHA-256, FIPS-approved). */
export function hashApiKey(key: string): string {
  return getCryptoProvider().hash("sha256", key, "hex");
}

/** Whether `value` is shaped like a Helix API key. */
export function isApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

// --- mTLS fingerprints ------------------------------------------------------

/**
 * Normalise a certificate SHA-256 fingerprint to lowercase hex with no
 * separators, so values from different TLS terminators (`AA:BB:..`, `aabb..`,
 * `sha256:..`) compare equal.
 */
export function normalizeCertFingerprint(fingerprint: string): string {
  return fingerprint
    .trim()
    .toLowerCase()
    .replace(/^sha-?256:/u, "")
    .replace(/[^0-9a-f]/gu, "");
}

/** Compute the SHA-256 fingerprint of a DER-encoded certificate. */
export function certFingerprintFromDer(der: Uint8Array): string {
  return getCryptoProvider().hash("sha256", der, "hex");
}

// --- request context for enforcement ---------------------------------------

export interface CredentialRequestContext {
  /** Caller IP address (e.g. Fastify `request.ip`). */
  readonly ip?: string;
  /** Client certificate fingerprint presented at the TLS layer. */
  readonly certFingerprint?: string;
  /** Evaluation time; defaults to now. Injectable for tests. */
  readonly at?: Date;
}

export type CredentialEnforcementCode =
  | "ip_not_allowed"
  | "outside_allowed_hours"
  | "cert_fingerprint_mismatch"
  | "credential_revoked"
  | "credential_expired";

export type CredentialEnforcementResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CredentialEnforcementCode; readonly message: string };

/**
 * Enforce a credential's per-credential policy fields against a request.
 * Checks (in order): revocation, expiry, IP allowlist, allowed-hours window,
 * and — for mTLS credentials — the bound certificate fingerprint.
 */
export function enforceCredentialPolicy(
  credential: AgentCredentialRecord,
  context: CredentialRequestContext,
): CredentialEnforcementResult {
  const now = context.at ?? new Date();

  if (credential.revokedAt !== null) {
    return { ok: false, code: "credential_revoked", message: "Credential has been revoked." };
  }
  if (credential.expiresAt !== null && credential.expiresAt <= now) {
    return { ok: false, code: "credential_expired", message: "Credential has expired." };
  }

  if (credential.credentialType === "mtls_cert") {
    const presented =
      context.certFingerprint === undefined
        ? null
        : normalizeCertFingerprint(context.certFingerprint);
    if (
      credential.certFingerprint === null ||
      presented === null ||
      !timingSafeStringEquals(presented, credential.certFingerprint)
    ) {
      return {
        ok: false,
        code: "cert_fingerprint_mismatch",
        message: "Client certificate fingerprint does not match the credential.",
      };
    }
  }

  if (credential.policy.ipAllowlist.length > 0) {
    if (context.ip === undefined || !ipMatchesAllowlist(context.ip, credential.policy.ipAllowlist)) {
      return {
        ok: false,
        code: "ip_not_allowed",
        message: "Request IP address is not in the credential's allowlist.",
      };
    }
  }

  if (
    credential.policy.allowedHours !== null &&
    !isWithinAllowedHours(credential.policy.allowedHours, now)
  ) {
    return {
      ok: false,
      code: "outside_allowed_hours",
      message: "Request is outside the credential's allowed-hours window.",
    };
  }

  return { ok: true };
}

/**
 * Authenticate a presented API key against the store and enforce its policy.
 * Returns the credential on success, or a failure describing the rejection.
 */
export async function authenticateApiKey(
  store: AgentCredentialStore,
  apiKey: string,
  context: CredentialRequestContext,
): Promise<
  | { readonly ok: true; readonly credential: AgentCredentialRecord }
  | { readonly ok: false; readonly code: CredentialEnforcementCode | "invalid_api_key"; readonly message: string }
> {
  const credential = await store.findByApiKeyHash(hashApiKey(apiKey));
  if (credential === null || credential.credentialType !== "api_key") {
    return { ok: false, code: "invalid_api_key", message: "Unknown or invalid API key." };
  }
  const enforcement = enforceCredentialPolicy(credential, context);
  if (!enforcement.ok) {
    return enforcement;
  }
  return { ok: true, credential };
}

/**
 * Authenticate a presented client certificate fingerprint against the store
 * and enforce its policy.
 */
export async function authenticateMtlsCertificate(
  store: AgentCredentialStore,
  fingerprint: string,
  context: CredentialRequestContext,
): Promise<
  | { readonly ok: true; readonly credential: AgentCredentialRecord }
  | { readonly ok: false; readonly code: CredentialEnforcementCode | "invalid_certificate"; readonly message: string }
> {
  const normalized = normalizeCertFingerprint(fingerprint);
  if (normalized.length === 0) {
    return { ok: false, code: "invalid_certificate", message: "No client certificate presented." };
  }
  const credential = await store.findByCertFingerprint(normalized);
  if (credential === null || credential.credentialType !== "mtls_cert") {
    return {
      ok: false,
      code: "invalid_certificate",
      message: "Client certificate is not registered.",
    };
  }
  const enforcement = enforceCredentialPolicy(credential, {
    ...context,
    certFingerprint: normalized,
  });
  if (!enforcement.ok) {
    return enforcement;
  }
  return { ok: true, credential };
}

// --- allowed-hours evaluation ----------------------------------------------

/** Whether `at` falls inside an {@link AllowedHoursWindow}. */
export function isWithinAllowedHours(window: AllowedHoursWindow, at: Date): boolean {
  const { hour, day } = resolveZonedHourAndDay(at, window.timeZone);
  if (window.days !== undefined && window.days.length > 0 && !window.days.includes(day)) {
    return false;
  }
  const { startHour, endHour } = window;
  if (startHour === endHour) {
    // Degenerate window: treated as "all hours allowed".
    return true;
  }
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Wrapping window, e.g. 22 -> 06.
  return hour >= startHour || hour < endHour;
}

function resolveZonedHourAndDay(
  at: Date,
  timeZone: string | undefined,
): { readonly hour: number; readonly day: number } {
  if (timeZone === undefined) {
    return { hour: at.getUTCHours(), day: at.getUTCDay() };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(at);
  const hourPart = parts.find((part) => part.type === "hour")?.value ?? "0";
  const weekdayPart = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number.parseInt(hourPart, 10) % 24;
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { hour, day: dayMap[weekdayPart] ?? 0 };
}

// --- IP allowlist evaluation -----------------------------------------------

/** Whether `ip` matches any entry (plain IP or CIDR) of the allowlist. */
export function ipMatchesAllowlist(ip: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => ipMatchesCidr(ip, entry));
}

/**
 * Match an IPv4 or IPv6 address against a single allowlist entry, which may be
 * a plain address or CIDR (`10.0.0.0/8`, `2001:db8::/32`).
 */
export function ipMatchesCidr(ip: string, entry: string): boolean {
  const normalizedIp = stripIpv6Zone(ip.trim());
  const [rangePart, prefixPart] = entry.trim().split("/");
  if (rangePart === undefined || rangePart.length === 0) {
    return false;
  }
  const ipBytes = parseIpAddress(normalizedIp);
  const rangeBytes = parseIpAddress(rangePart);
  if (ipBytes === null || rangeBytes === null || ipBytes.length !== rangeBytes.length) {
    return false;
  }
  const maxPrefix = ipBytes.length * 8;
  const prefix = prefixPart === undefined ? maxPrefix : Number.parseInt(prefixPart, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    return false;
  }
  let bitsRemaining = prefix;
  for (let index = 0; index < ipBytes.length; index += 1) {
    if (bitsRemaining <= 0) {
      break;
    }
    const bits = Math.min(8, bitsRemaining);
    const mask = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
    if (((ipBytes[index] ?? 0) & mask) !== ((rangeBytes[index] ?? 0) & mask)) {
      return false;
    }
    bitsRemaining -= bits;
  }
  return true;
}

function stripIpv6Zone(ip: string): string {
  const zoneIndex = ip.indexOf("%");
  return zoneIndex < 0 ? ip : ip.slice(0, zoneIndex);
}

function parseIpAddress(value: string): number[] | null {
  if (value.includes(":")) {
    return parseIpv6(value);
  }
  return parseIpv4(value);
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const byte = Number.parseInt(part, 10);
    if (byte > 255) {
      return null;
    }
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(value: string): number[] | null {
  // Reject IPv4-mapped forms for simplicity; allowlists should use one family.
  const halves = value.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1]?.split(":") ?? [])) : [];
  const explicit = halves.length === 2 ? head.length + tail.length : head.length;
  if (explicit > 8 || (halves.length === 1 && explicit !== 8)) {
    return null;
  }
  const groups: number[] = [];
  for (const group of head) {
    const parsed = parseHextet(group);
    if (parsed === null) {
      return null;
    }
    groups.push(parsed);
  }
  for (let index = 0; index < 8 - explicit; index += 1) {
    groups.push(0);
  }
  for (const group of tail) {
    const parsed = parseHextet(group);
    if (parsed === null) {
      return null;
    }
    groups.push(parsed);
  }
  if (groups.length !== 8) {
    return null;
  }
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function parseHextet(group: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) {
    return null;
  }
  return Number.parseInt(group, 16);
}

// --- credential factory helpers --------------------------------------------

export interface ApiKeyCreateResult {
  readonly apiKey: string;
  readonly apiKeyHash: string;
}

/** Mint a new API key and return it together with its storable hash. */
export function createApiKeyMaterial(): ApiKeyCreateResult {
  const apiKey = generateApiKey();
  return { apiKey, apiKeyHash: hashApiKey(apiKey) };
}

function timingSafeStringEquals(left: string, right: string): boolean {
  return getCryptoProvider().timingSafeEqual(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}
