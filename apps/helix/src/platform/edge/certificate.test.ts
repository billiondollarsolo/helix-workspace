import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestCertificateAuthority,
  type TestCertificateAuthority,
  type TestServerCertificate,
} from "../../test-support/tls-fixtures.js";
import {
  EdgeCertificateError,
  parseEdgeCertificate,
  PEM_PRIVATE_KEY_HEADER,
} from "./certificate.js";

const hostname = "workspace.example.test";

describe("parseEdgeCertificate", () => {
  let authority: TestCertificateAuthority;
  let server: TestServerCertificate;
  // Certificates issued during a test begin after the suite started.
  const now = new Date(Date.now() + 60_000);

  beforeAll(() => {
    authority = createTestCertificateAuthority();
    server = authority.issue([hostname, "mail.example.test"]);
  });

  afterAll(() => {
    authority.dispose();
  });

  function refusal(
    input: Partial<Parameters<typeof parseEdgeCertificate>[0]>,
  ): EdgeCertificateError {
    try {
      parseEdgeCertificate({
        certificatePem: server.certificatePem + authority.intermediatePem,
        privateKeyPem: server.privateKeyPem,
        hostname,
        now,
        ...input,
      });
    } catch (error) {
      if (error instanceof EdgeCertificateError) return error;
      throw error;
    }
    throw new Error("The certificate was accepted.");
  }

  it("accepts a certificate with its intermediate and describes it", () => {
    const parsed = parseEdgeCertificate({
      certificatePem: `${server.certificatePem}\n${authority.intermediatePem}`,
      privateKeyPem: server.privateKeyPem,
      hostname,
      now,
    });

    expect(parsed.summary).toMatchObject({
      subject: hostname,
      issuer: "Test Issuing CA",
      names: [hostname, "mail.example.test"],
    });
    expect(parsed.summary.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Date(parsed.summary.notAfter).getTime()).toBeGreaterThan(now.getTime());
    expect(parsed.chainPem.match(/BEGIN CERTIFICATE/gu)).toHaveLength(2);
    expect(parsed.keyPem).toContain(PEM_PRIVATE_KEY_HEADER);
  });

  it("accepts a wildcard certificate and an ECDSA key", () => {
    const wildcard = authority.issue(["*.example.test"], { key: "ec:prime256v1" });

    const parsed = parseEdgeCertificate({
      certificatePem: wildcard.certificatePem,
      privateKeyPem: wildcard.privateKeyPem,
      hostname,
      now,
    });

    expect(parsed.summary.names).toEqual(["*.example.test"]);
  });

  it("describes a certificate that is identified only by its alternative names", () => {
    // What Caddy's internal issuer and some private CAs produce: no subject at all.
    const nameless = authority.issue([hostname], { emptySubject: true });

    const parsed = parseEdgeCertificate({
      certificatePem: nameless.certificatePem,
      privateKeyPem: nameless.privateKeyPem,
      hostname,
      now,
    });

    expect(parsed.summary).toMatchObject({ subject: hostname, names: [hostname] });
  });

  it("refuses a certificate for another name and says which names it covers", () => {
    const other = authority.issue(["other.example.test"]);

    const error = refusal({
      certificatePem: other.certificatePem,
      privateKeyPem: other.privateKeyPem,
    });

    expect(error.field).toBe("certificate");
    expect(error.message).toBe(
      `This certificate covers other.example.test. It must cover ${hostname}.`,
    );
  });

  it("asks for the server certificate first when the chain is out of order", () => {
    expect(
      refusal({ certificatePem: authority.intermediatePem + server.certificatePem }).message,
    ).toBe(`Put the certificate for ${hostname} first, followed by its intermediates.`);
    expect(refusal({ certificatePem: server.certificatePem + authority.rootPem }).message).toBe(
      "Certificate 2 did not issue certificate 1. Put the intermediates in order after your certificate.",
    );
  });

  it("refuses a certificate outside its validity period", () => {
    const later = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    expect(refusal({ now: later }).message).toMatch(
      /^This certificate expired on \d{4}-\d{2}-\d{2}\. Upload its renewal\.$/u,
    );
    const earlier = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(refusal({ now: earlier }).message).toMatch(
      /^This certificate is not valid until \d{4}-\d{2}-\d{2}\.$/u,
    );
  });

  it("refuses a private key that belongs to another certificate", () => {
    const other = authority.issue([hostname]);

    const error = refusal({ privateKeyPem: other.privateKeyPem });

    expect(error.field).toBe("privateKey");
    expect(error.message).toBe("The private key does not belong to this certificate.");
  });

  it("explains how to remove a passphrase instead of failing to read the key", () => {
    const encrypted = execFileSync(
      "openssl",
      ["pkey", "-aes256", "-passout", "pass:not-a-real-passphrase"],
      { input: server.privateKeyPem },
    ).toString();

    expect(refusal({ privateKeyPem: encrypted }).message).toBe(
      "The private key is protected by a passphrase. Remove it first: openssl pkey -in key.pem -out key-plain.pem",
    );
  });

  it("refuses weak and unsupported keys", () => {
    for (const key of ["rsa:1024", "ed25519"] as const) {
      const weak = authority.issue([hostname], { key });
      expect(
        refusal({ certificatePem: weak.certificatePem, privateKeyPem: weak.privateKeyPem }).message,
      ).toBe("Use an RSA key of 2048 bits or more, or an ECDSA P-256 or P-384 key.");
    }
  });

  it("explains unreadable input", () => {
    expect(refusal({ certificatePem: "not a certificate" }).message).toBe(
      "Paste the certificate in PEM format, starting with -----BEGIN CERTIFICATE-----.",
    );
    expect(
      refusal({
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" + server.certificatePem,
      }).message,
    ).toBe("Certificate 1 could not be read. Copy it again, including the BEGIN and END lines.");
    expect(refusal({ privateKeyPem: "" }).message).toBe(
      `Paste the private key in PEM format, starting with ${PEM_PRIVATE_KEY_HEADER}.`,
    );
    expect(refusal({ privateKeyPem: server.privateKeyPem + server.privateKeyPem }).message).toBe(
      "Paste exactly one private key.",
    );
    expect(refusal({ certificatePem: server.certificatePem.repeat(9) }).message).toBe(
      "Include at most 8 certificates: yours, then its intermediates.",
    );
  });
});
