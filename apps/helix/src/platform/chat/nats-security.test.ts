import { describe, expect, it } from "vitest";
import { createChatNatsSecurityPolicy } from "./nats-security.js";

describe("Chat NATS production security", () => {
  it("requires authentication and CA-pinned mTLS in production", () => {
    expect(() =>
      createChatNatsSecurityPolicy({ NODE_ENV: "production", NATS_URL: "tls://nats:4222" }, []),
    ).toThrow("authenticated credentials");
    expect(() =>
      createChatNatsSecurityPolicy(
        {
          NODE_ENV: "production",
          NATS_URL: "tls://nats:4222",
          NATS_USER: "chat",
          NATS_PASSWORD: "secret",
        },
        [],
      ),
    ).toThrow("mutual TLS");
  });

  it("builds authenticated mTLS options and tenant-limited subject grants", () => {
    const policy = createChatNatsSecurityPolicy(
      {
        NODE_ENV: "production",
        NATS_URL: "tls://nats-a:4222,tls://nats-b:4222",
        NATS_USER: "chat",
        NATS_PASSWORD: "secret",
        NATS_TLS_CA_FILE: "/run/secrets/nats-ca.pem",
        NATS_TLS_CERT_FILE: "/run/secrets/nats-cert.pem",
        NATS_TLS_KEY_FILE: "/run/secrets/nats-key.pem",
      },
      ["org-a", "org-b"],
    );
    expect(policy.connection).toMatchObject({
      servers: ["tls://nats-a:4222", "tls://nats-b:4222"],
      user: "chat",
      pass: "secret",
      tls: {
        rejectUnauthorized: true,
        caFile: "/run/secrets/nats-ca.pem",
        certFile: "/run/secrets/nats-cert.pem",
        keyFile: "/run/secrets/nats-key.pem",
      },
    });
    expect(policy.publishSubjects).toEqual([
      "helix.chat.org.org-a.room.*.events",
      "helix.chat.org.org-b.room.*.events",
    ]);
  });

  it("rejects ambiguous or partial credentials", () => {
    expect(() => createChatNatsSecurityPolicy({ NATS_USER: "chat" }, [], false)).toThrow(
      "configured together",
    );
    expect(() =>
      createChatNatsSecurityPolicy(
        { NATS_USER: "chat", NATS_PASSWORD: "secret", NATS_TOKEN: "token" },
        [],
        false,
      ),
    ).toThrow("cannot be combined");
  });
});
