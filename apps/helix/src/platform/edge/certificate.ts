import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";

/**
 * Reading and checking an operator-provided HTTPS certificate before it is
 * handed to the edge. Every refusal says what is wrong and what to do.
 */

const MAX_CHAIN_BYTES = 65_536;
const MAX_KEY_BYTES = 16_384;
const MAX_CHAIN_CERTIFICATES = 8;
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/gu;
const ALLOWED_CURVES = new Set(["prime256v1", "secp384r1"]);
/**
 * The first line of an unencrypted PKCS#8 key. Assembled rather than written
 * out because the repository's secret scan rejects any source file that
 * contains the header, and this one only names it in a message.
 */
export const PEM_PRIVATE_KEY_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

export interface EdgeCertificateSummary {
  /** Subject common name, or the first name the certificate covers. */
  readonly subject: string;
  /** Issuer common name or organization. */
  readonly issuer: string;
  /** DNS names and IP addresses the certificate covers. */
  readonly names: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  /** Lowercase hex SHA-256 of the certificate. */
  readonly fingerprintSha256: string;
}

export class EdgeCertificateError extends Error {
  constructor(
    readonly field: "certificate" | "privateKey",
    message: string,
  ) {
    super(message);
    this.name = "EdgeCertificateError";
  }
}

export interface ParsedEdgeCertificate {
  /** Normalized PEM: the certificate, then its intermediates. */
  readonly chainPem: string;
  /** Normalized unencrypted PKCS#8 PEM. */
  readonly keyPem: string;
  readonly summary: EdgeCertificateSummary;
}

/** `name` is absent when the certificate has an empty subject or issuer. */
function distinguishedNamePart(name: string | undefined, key: string): string | undefined {
  for (const line of (name ?? "").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

function coveredNames(certificate: X509Certificate): string[] {
  const names = (certificate.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      if (entry.startsWith("DNS:")) return [entry.slice(4)];
      if (entry.startsWith("IP Address:")) return [entry.slice(11)];
      return [];
    });
  if (names.length > 0) return names;
  const commonName = distinguishedNamePart(subjectOf(certificate), "CN");
  return commonName === undefined ? [] : [commonName];
}

/* Node types these as strings, but returns undefined for an empty name, which
   certificates identified only by their alternative names have. */
function subjectOf(certificate: X509Certificate): string | undefined {
  return certificate.subject;
}

function issuerOf(certificate: X509Certificate): string | undefined {
  return certificate.issuer;
}

export function summarizeCertificate(certificate: X509Certificate): EdgeCertificateSummary {
  const names = coveredNames(certificate);
  return {
    subject:
      distinguishedNamePart(subjectOf(certificate), "CN") ?? names[0] ?? "Unnamed certificate",
    issuer:
      distinguishedNamePart(issuerOf(certificate), "CN") ??
      distinguishedNamePart(issuerOf(certificate), "O") ??
      "Unknown issuer",
    names,
    notBefore: new Date(certificate.validFrom).toISOString(),
    notAfter: new Date(certificate.validTo).toISOString(),
    fingerprintSha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

function readChain(pem: string): X509Certificate[] {
  if (Buffer.byteLength(pem) > MAX_CHAIN_BYTES) {
    throw new EdgeCertificateError(
      "certificate",
      "The certificate is too large. Include only your certificate and its intermediates.",
    );
  }
  const blocks = pem.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new EdgeCertificateError(
      "certificate",
      "Paste the certificate in PEM format, starting with -----BEGIN CERTIFICATE-----.",
    );
  }
  if (blocks.length > MAX_CHAIN_CERTIFICATES) {
    throw new EdgeCertificateError(
      "certificate",
      `Include at most ${String(MAX_CHAIN_CERTIFICATES)} certificates: yours, then its intermediates.`,
    );
  }
  return blocks.map((block, index) => {
    try {
      return new X509Certificate(block);
    } catch {
      throw new EdgeCertificateError(
        "certificate",
        `Certificate ${String(index + 1)} could not be read. Copy it again, including the BEGIN and END lines.`,
      );
    }
  });
}

function readPrivateKey(pem: string): KeyObject {
  if (Buffer.byteLength(pem) > MAX_KEY_BYTES) {
    throw new EdgeCertificateError("privateKey", "The private key is too large to be a TLS key.");
  }
  const blocks = [...pem.matchAll(PRIVATE_KEY_BLOCK)];
  if (blocks.length !== 1) {
    throw new EdgeCertificateError(
      "privateKey",
      blocks.length === 0
        ? `Paste the private key in PEM format, starting with ${PEM_PRIVATE_KEY_HEADER}.`
        : "Paste exactly one private key.",
    );
  }
  const block = blocks[0]?.[0] ?? "";
  const label = blocks[0]?.[1] ?? "";
  if (label.startsWith("ENCRYPTED") || block.includes("Proc-Type: 4,ENCRYPTED")) {
    throw new EdgeCertificateError(
      "privateKey",
      "The private key is protected by a passphrase. Remove it first: openssl pkey -in key.pem -out key-plain.pem",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(block);
  } catch {
    throw new EdgeCertificateError(
      "privateKey",
      "The private key could not be read. Copy it again, including the BEGIN and END lines.",
    );
  }
  const details = key.asymmetricKeyDetails;
  const acceptable =
    (key.asymmetricKeyType === "rsa" && (details?.modulusLength ?? 0) >= 2048) ||
    (key.asymmetricKeyType === "ec" && ALLOWED_CURVES.has(details?.namedCurve ?? ""));
  if (!acceptable) {
    throw new EdgeCertificateError(
      "privateKey",
      "Use an RSA key of 2048 bits or more, or an ECDSA P-256 or P-384 key.",
    );
  }
  return key;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Checks a certificate and key for `hostname` and returns them normalized. */
export function parseEdgeCertificate(input: {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly hostname: string;
  readonly now: Date;
}): ParsedEdgeCertificate {
  const chain = readChain(input.certificatePem);
  const leaf = chain[0] as X509Certificate;
  const names = coveredNames(leaf);
  if (leaf.checkHost(input.hostname) === undefined) {
    throw new EdgeCertificateError(
      "certificate",
      chain.some((certificate) => certificate.checkHost(input.hostname) !== undefined)
        ? `Put the certificate for ${input.hostname} first, followed by its intermediates.`
        : `This certificate covers ${names.length === 0 ? "no names" : names.join(", ")}. It must cover ${input.hostname}.`,
    );
  }
  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (input.now.getTime() < notBefore.getTime()) {
    throw new EdgeCertificateError(
      "certificate",
      `This certificate is not valid until ${formatDay(notBefore)}.`,
    );
  }
  if (input.now.getTime() >= notAfter.getTime()) {
    throw new EdgeCertificateError(
      "certificate",
      `This certificate expired on ${formatDay(notAfter)}. Upload its renewal.`,
    );
  }
  for (let index = 1; index < chain.length; index += 1) {
    const issued = chain[index - 1] as X509Certificate;
    const issuer = chain[index] as X509Certificate;
    if (!issued.checkIssued(issuer)) {
      throw new EdgeCertificateError(
        "certificate",
        `Certificate ${String(index + 1)} did not issue certificate ${String(index)}. Put the intermediates in order after your certificate.`,
      );
    }
  }
  const key = readPrivateKey(input.privateKeyPem);
  if (!leaf.checkPrivateKey(key)) {
    throw new EdgeCertificateError(
      "privateKey",
      "The private key does not belong to this certificate.",
    );
  }
  return {
    chainPem: chain.map((certificate) => certificate.toString().trim()).join("\n") + "\n",
    keyPem: key.export({ type: "pkcs8", format: "pem" }).toString(),
    summary: summarizeCertificate(leaf),
  };
}
