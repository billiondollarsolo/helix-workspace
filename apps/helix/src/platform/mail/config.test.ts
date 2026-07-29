import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import { mailConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
  MAIL_FROM_DOMAIN: "helix.test",
  MAIL_SMTP_HOST: "smtp.helix.test",
};

describe("mailConfig", () => {
  it("derives the from-domain and outbound host from validated env", () => {
    const cfg = mailConfig(loadEnv(base));
    expect(cfg.fromDomain).toBe("helix.test");
    expect(cfg.outbound?.host).toBe("smtp.helix.test");
  });

  it("defaults from-domain to localhost when unset", () => {
    expect(
      mailConfig(
        loadEnv({
          DATABASE_URL: base.DATABASE_URL,
          REDIS_URL: base.REDIS_URL,
        }),
      ).fromDomain,
    ).toBe("localhost");
  });

  it("builds receiver config when enabled", () => {
    const cfg = mailConfig(
      loadEnv({
        ...base,
        MAIL_SMTP_RECEIVER_ENABLED: "true",
        MAIL_SMTP_RECEIVER_HOST: "0.0.0.0",
        MAIL_SMTP_RECEIVER_PORT: "2525",
        MAIL_SMTP_RECEIVER_MAX_MESSAGE_BYTES: "1048576",
        MAIL_SMTP_RECEIVER_MAX_RECIPIENTS: "25",
      }),
    );
    expect(cfg.receiver).toMatchObject({
      host: "0.0.0.0",
      port: 2525,
      transportSecurity: { mode: "development-plaintext" },
      limits: { maxMessageBytes: 1_048_576, maxRecipientsPerMessage: 25 },
    });
  });

  it("fails closed on production transport and validates explicit STARTTLS/proxy modes", () => {
    expect(() =>
      mailConfig(
        loadEnv({
          ...base,
          NODE_ENV: "production",
          MAIL_SMTP_RECEIVER_ENABLED: "true",
        }),
      ),
    ).toThrow("TRANSPORT_SECURITY");

    expect(
      mailConfig(
        loadEnv({
          ...base,
          NODE_ENV: "production",
          MAIL_SMTP_RECEIVER_ENABLED: "true",
          MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY: "starttls",
          MAIL_SMTP_RECEIVER_TLS_KEY: "private key",
          MAIL_SMTP_RECEIVER_TLS_CERT: "certificate",
        }),
      ).receiver?.transportSecurity,
    ).toMatchObject({ mode: "starttls", key: "private key", cert: "certificate" });

    expect(() =>
      mailConfig(
        loadEnv({
          ...base,
          NODE_ENV: "production",
          MAIL_SMTP_RECEIVER_ENABLED: "true",
          MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY: "trusted-proxy",
        }),
      ),
    ).toThrow("PROXY protocol");

    expect(
      mailConfig(
        loadEnv({
          ...base,
          NODE_ENV: "production",
          MAIL_SMTP_RECEIVER_ENABLED: "true",
          MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY: "trusted-proxy",
          MAIL_SMTP_RECEIVER_PROXY_PROTOCOL: "true",
          MAIL_SMTP_RECEIVER_TRUSTED_PROXY_IPS: "10.0.0.10, 10.0.0.11",
        }),
      ).receiver?.transportSecurity,
    ).toEqual({
      mode: "trusted-proxy",
      proxyProtocol: true,
      trustedProxyIps: ["10.0.0.10", "10.0.0.11"],
    });

    expect(() =>
      mailConfig(
        loadEnv({
          ...base,
          NODE_ENV: "production",
          MAIL_SMTP_RECEIVER_ENABLED: "true",
          MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY: "trusted-proxy",
          MAIL_SMTP_RECEIVER_PROXY_PROTOCOL: "true",
          MAIL_SMTP_RECEIVER_TRUSTED_PROXY_IPS: "not-an-ip",
        }),
      ),
    ).toThrow("TRUSTED_PROXY_IPS");
  });

  it("builds spamd/clamav when enabled", () => {
    const cfg = mailConfig(
      loadEnv({
        ...base,
        MAIL_SPAMD_ENABLED: "true",
        MAIL_SPAMD_HOST: "spam.internal",
        MAIL_CLAMAV_ENABLED: "1",
        MAIL_CLAMAV_HOST: "av.internal",
      }),
    );
    expect(cfg.spamd?.host).toBe("spam.internal");
    expect(cfg.clamav?.host).toBe("av.internal");
    expect(cfg.clamav?.tier).toBe("personal");
  });

  it("propagates the organization security tier into ClamAV policy", () => {
    const cfg = mailConfig(
      loadEnv({
        ...base,
        MAIL_CLAMAV_ENABLED: "true",
        MAIL_CLAMAV_HOST: "av.internal",
      }),
      "business",
    );

    expect(cfg.clamav).toMatchObject({
      host: "av.internal",
      tier: "business",
    });
  });
});
