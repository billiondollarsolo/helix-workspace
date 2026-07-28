import { describe, expect, it } from "vitest";
import { smtpDisabledCommands, smtpTransportSecurityOptions } from "./smtp-transport-security.js";

describe("SMTP transport security", () => {
  it("offers STARTTLS only with explicit key material and TLS 1.2 minimum", () => {
    expect(
      smtpTransportSecurityOptions({
        mode: "starttls",
        key: "private-key",
        cert: "certificate",
      }),
    ).toMatchObject({
      secure: false,
      hideSTARTTLS: false,
      minVersion: "TLSv1.2",
    });
    expect(
      smtpDisabledCommands({ mode: "starttls", key: "private-key", cert: "certificate" }, [
        "AUTH",
        "STARTTLS",
      ]),
    ).not.toContain("STARTTLS");
  });

  it("marks a trusted proxy connection as secured and disables local STARTTLS", () => {
    expect(
      smtpTransportSecurityOptions({ mode: "trusted-proxy", proxyProtocol: true }),
    ).toMatchObject({
      secured: true,
      hideSTARTTLS: true,
      useProxy: true,
    });
    expect(smtpDisabledCommands({ mode: "trusted-proxy", proxyProtocol: true })).toContain(
      "STARTTLS",
    );
  });

  it("requires non-empty direct TLS material", () => {
    expect(() =>
      smtpTransportSecurityOptions({ mode: "starttls", key: "", cert: "certificate" }),
    ).toThrow("key");
  });
});
