import { describe, expect, it } from "vitest";
import { resolvePostgresSsl } from "./postgres-connection.js";

describe("resolvePostgresSsl", () => {
  const readFile = () => Buffer.from("pem");

  it("requires a pinned CA in production", () => {
    expect(() => resolvePostgresSsl({ NODE_ENV: "production" }, readFile)).toThrow("pinned TLS CA");
  });

  it("builds a certificate-verifying TLS policy", () => {
    expect(
      resolvePostgresSsl(
        {
          NODE_ENV: "production",
          POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
        },
        readFile,
      ),
    ).toMatchObject({
      rejectUnauthorized: true,
      ca: Buffer.from("pem"),
    });
  });

  it("supports optional mTLS only as a complete certificate/key pair", () => {
    expect(() =>
      resolvePostgresSsl(
        {
          POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
          POSTGRES_TLS_CERT_FILE: "/run/secrets/postgres_client_cert",
        },
        readFile,
      ),
    ).toThrow("certificate and key");

    expect(
      resolvePostgresSsl(
        {
          POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
          POSTGRES_TLS_CERT_FILE: "/run/secrets/postgres_client_cert",
          POSTGRES_TLS_KEY_FILE: "/run/secrets/postgres_client_key",
        },
        readFile,
      ),
    ).toMatchObject({
      cert: Buffer.from("pem"),
      key: Buffer.from("pem"),
    });
  });

  it("keeps local development plaintext-compatible when TLS is not configured", () => {
    expect(resolvePostgresSsl({ NODE_ENV: "development" }, readFile)).toBe(false);
  });
});
