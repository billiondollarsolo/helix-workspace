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
      }),
    );
    expect(cfg.receiver).toMatchObject({ host: "0.0.0.0", port: 2525 });
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
