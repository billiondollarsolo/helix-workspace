import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isCanonicalPluginId } from "@helix/sdk-types";
import {
  createVerifier as createSigstoreVerifier,
  type Bundle,
  type BundleVerifier,
  type VerifyOptions,
} from "sigstore";

const PUBLISHER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const verifierCache = new WeakMap<PluginTrustOptions, Map<string, Promise<BundleVerifier>>>();

export interface PluginCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly bundleDigest: string;
  readonly publisher: string;
  readonly sigstoreBundle: Bundle;
}

export interface PluginCatalogPayload {
  readonly version: 1;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly plugins: readonly PluginCatalogEntry[];
}

export interface SignedPluginCatalog {
  readonly keyId: string;
  readonly payload: PluginCatalogPayload;
  readonly signature: string;
}

export interface PluginTrustOptions {
  readonly catalog: SignedPluginCatalog;
  readonly trustedCatalogKeys: Readonly<Record<string, string>>;
  readonly revokedKeyIds?: readonly string[];
  readonly trustedPublishers: Readonly<Record<string, TrustedPluginPublisher>>;
  readonly revokedPublishers?: readonly string[];
  /** Test seam; production omits this and always uses Sigstore's verifier. */
  readonly createBundleVerifier?: ((options: VerifyOptions) => Promise<BundleVerifier>) | undefined;
  readonly now?: () => Date;
}

export type TrustedPluginPublisher =
  | {
      readonly issuer: string;
      readonly email: string;
      readonly uri?: never;
      readonly tufRootPath?: string;
      readonly tufMirrorUrl?: string;
    }
  | {
      readonly issuer: string;
      readonly uri: string;
      readonly email?: never;
      readonly tufRootPath?: string;
      readonly tufMirrorUrl?: string;
    };

export function verifyPluginCatalog(
  options: PluginTrustOptions | undefined,
): PluginCatalogPayload | undefined {
  if (options === undefined) return undefined;
  const { catalog } = options;
  if (options.revokedKeyIds?.includes(catalog.keyId) === true) {
    throw new Error(`Plugin catalog signing key ${catalog.keyId} is revoked.`);
  }
  const trustedKey = options.trustedCatalogKeys[catalog.keyId];
  if (trustedKey === undefined) {
    throw new Error(`Plugin catalog signing key ${catalog.keyId} is not trusted.`);
  }
  const payload: unknown = catalog.payload;
  assertCatalogPayload(payload, options.now?.() ?? new Date());
  const publicKey = createPublicKey(trustedKey);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Plugin catalog keys must be Ed25519 public keys.");
  }
  const signature = decodeBase64(catalog.signature);
  if (!verify(null, pluginCatalogPayloadBytes(payload), publicKey, signature)) {
    throw new Error("Plugin catalog signature verification failed.");
  }
  for (const entry of payload.plugins) {
    if (options.revokedPublishers?.includes(entry.publisher) === true) {
      throw new Error(`Plugin publisher ${entry.publisher} is revoked.`);
    }
    const publisher = options.trustedPublishers[entry.publisher];
    if (publisher === undefined) {
      throw new Error(`Plugin publisher ${entry.publisher} is not trusted.`);
    }
    sigstoreVerifyOptions(publisher);
  }
  return payload;
}

export async function loadPluginTrustFile(
  path: string | undefined,
): Promise<PluginTrustOptions | undefined> {
  if (path === undefined) return undefined;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isPluginTrustOptions(value)) {
    throw new Error("Plugin trust file is invalid.");
  }
  verifyPluginCatalog(value);
  return value;
}

function isPluginTrustOptions(value: unknown): value is PluginTrustOptions {
  return (
    isRecord(value) &&
    isRecord(value.catalog) &&
    isRecord(value.trustedCatalogKeys) &&
    Object.values(value.trustedCatalogKeys).every((key) => typeof key === "string") &&
    isRecord(value.trustedPublishers) &&
    (value.revokedKeyIds === undefined || stringArray(value.revokedKeyIds)) &&
    (value.revokedPublishers === undefined || stringArray(value.revokedPublishers))
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function pluginCatalogPayloadBytes(payload: PluginCatalogPayload): Buffer {
  return Buffer.from(canonicalizeJson(payload), "utf8");
}

export function catalogArtifact(
  catalog: PluginCatalogPayload | undefined,
  id: string,
  version: string,
): PluginCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.id === id && entry.version === version);
}

/**
 * Verify the catalog-pinned digest with Sigstore's maintained Fulcio/Rekor
 * implementation. The catalog selects only a server-configured publisher;
 * it cannot supply its own issuer, identity, trust root, or verification key.
 */
export async function verifyPluginArtifactSignature(
  entry: PluginCatalogEntry,
  actualBundleDigest: string,
  trust: PluginTrustOptions,
): Promise<void> {
  if (entry.bundleDigest !== actualBundleDigest) {
    throw new Error(
      `Plugin ${entry.id} bundle digest mismatch: expected ${entry.bundleDigest}, got ${actualBundleDigest}.`,
    );
  }
  if (trust.revokedPublishers?.includes(entry.publisher) === true) {
    throw new Error(`Plugin publisher ${entry.publisher} is revoked.`);
  }
  const publisher = trust.trustedPublishers[entry.publisher];
  if (publisher === undefined) {
    throw new Error(`Plugin publisher ${entry.publisher} is not trusted.`);
  }
  const options = sigstoreVerifyOptions(publisher);
  const verifier = await bundleVerifier(trust, entry.publisher, options);
  try {
    verifier.verify(entry.sigstoreBundle, Buffer.from(actualBundleDigest, "utf8"));
  } catch (error) {
    throw new Error(`Plugin ${entry.id} Sigstore verification failed.`, { cause: error });
  }
}

async function bundleVerifier(
  trust: PluginTrustOptions,
  publisher: string,
  options: VerifyOptions,
): Promise<BundleVerifier> {
  let publishers = verifierCache.get(trust);
  if (publishers === undefined) {
    publishers = new Map();
    verifierCache.set(trust, publishers);
  }
  const cached = publishers.get(publisher);
  if (cached !== undefined) return cached;
  const pending = (trust.createBundleVerifier ?? createSigstoreVerifier)(options);
  publishers.set(publisher, pending);
  try {
    return await pending;
  } catch (error) {
    publishers.delete(publisher);
    throw error;
  }
}

function assertCatalogPayload(
  payload: unknown,
  now: Date,
): asserts payload is PluginCatalogPayload {
  if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.plugins)) {
    throw new Error("Plugin catalog payload is invalid.");
  }
  const issuedAt = typeof payload.issuedAt === "string" ? Date.parse(payload.issuedAt) : Number.NaN;
  const expiresAt =
    typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  if (!Number.isFinite(issuedAt) || issuedAt > now.valueOf() + 5 * 60_000) {
    throw new Error("Plugin catalog issuedAt is invalid or in the future.");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now.valueOf()) {
    throw new Error("Plugin catalog is expired.");
  }
  const identities = new Set<string>();
  for (const entry of payload.plugins) {
    if (!isRecord(entry)) {
      throw new Error("Plugin catalog entry is invalid.");
    }
    const id = entry.id;
    const version = entry.version;
    const bundleDigest = entry.bundleDigest;
    const publisher = entry.publisher;
    const identity = `${String(id)}@${String(version)}`;
    if (
      !isCanonicalPluginId(id) ||
      typeof version !== "string" ||
      version.length === 0 ||
      typeof bundleDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(bundleDigest) ||
      typeof publisher !== "string" ||
      !PUBLISHER_ID.test(publisher) ||
      !isRecord(entry.sigstoreBundle) ||
      identities.has(identity)
    ) {
      throw new Error(`Plugin catalog entry ${identity} is invalid or duplicated.`);
    }
    identities.add(identity);
  }
}

function sigstoreVerifyOptions(publisher: TrustedPluginPublisher): VerifyOptions {
  const issuer = parseHttpsUrl(publisher.issuer, "publisher issuer");
  const identity = "email" in publisher ? publisher.email : publisher.uri;
  if (identity.length === 0 || identity.length > 2048) {
    throw new Error("Plugin publisher identity is invalid.");
  }
  if (!("email" in publisher)) {
    parseHttpsUrl(identity, "publisher URI identity");
  }
  if (publisher.tufMirrorUrl !== undefined) {
    parseHttpsUrl(publisher.tufMirrorUrl, "Sigstore TUF mirror");
  }
  return {
    certificateIssuer: issuer,
    ...("email" in publisher
      ? { certificateIdentityEmail: exactPattern(identity) }
      : { certificateIdentityURI: exactPattern(identity) }),
    ctLogThreshold: 1,
    tlogThreshold: 1,
    timeout: 5_000,
    ...(publisher.tufRootPath === undefined ? {} : { tufRootPath: publisher.tufRootPath }),
    ...(publisher.tufMirrorUrl === undefined ? {} : { tufMirrorURL: publisher.tufMirrorUrl }),
  };
}

function exactPattern(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

function parseHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  return parsed.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("Plugin catalog signature must be canonical base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Plugin catalog signature must be canonical base64.");
  }
  return decoded;
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
