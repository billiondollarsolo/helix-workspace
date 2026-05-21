import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import {
  MailAdminStatusService,
  canReadMailAdminStatus,
  emptyDeliveryHealth,
  registerMailAdminRoutes,
  type MailAdminDeliveryHealthStore,
} from "./admin-config.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.config.read"],
};

describe("mail admin configuration status", () => {
  it("projects env-backed inbound, outbound, DNS, quota, and delivery status without secrets", async () => {
    const store: MailAdminDeliveryHealthStore = {
      async getOutboundDeliveryHealth(input) {
        return {
          ...emptyDeliveryHealth(input.since, "ok"),
          counts: { queued: 2, sending: 1, sent: 9, failed: 1, cancelled: 0 },
          failedLast24h: 1,
          lastFailureAt: "2026-05-21T12:30:00.000Z",
          lastError: "550 rejected",
        };
      },
    };
    const service = new MailAdminStatusService({
      env: {
        HELIX_DEFAULT_ORG_ID: actor.orgId,
        HELIX_MAIL_DOMAINS: "example.com, alt.example",
        MAIL_FROM_DOMAIN: "example.com",
        MAIL_SMTP_HOST: "smtp.example.com",
        MAIL_SMTP_PORT: "587",
        MAIL_SMTP_SECURE: "false",
        MAIL_SMTP_USER: "mailer",
        MAIL_SMTP_PASS: "secret",
        MAIL_SMTP_RECEIVER_ENABLED: "true",
        MAIL_SMTP_RECEIVER_HOST: "0.0.0.0",
        MAIL_SMTP_RECEIVER_PORT: "2525",
        MAIL_DNS_MX_VERIFIED: "true",
        MAIL_SPF_RECORD: "v=spf1 include:example.net -all",
        MAIL_DKIM_SELECTOR: "helix",
        MAIL_DMARC_POLICY: "p=quarantine",
        MAIL_SEND_RATE_LIMIT_PER_HOUR: "80",
        MAIL_SEND_RATE_LIMIT_PER_DAY: "400",
        MAIL_MAX_MESSAGE_BYTES: "26214400",
      },
      deliveryHealthStore: store,
      now: () => new Date("2026-05-21T13:00:00.000Z"),
    });

    const status = await service.getStatus(actor);

    expect(status.inboundReceiver).toMatchObject({
      enabled: true,
      status: "ready",
      host: "0.0.0.0",
      port: 2525,
      orgId: actor.orgId,
    });
    expect(status.outboundRelay).toMatchObject({
      configured: true,
      status: "ready",
      provider: "smtp",
      host: "smtp.example.com",
      port: 587,
      secure: false,
      authConfigured: true,
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status.domains).toHaveLength(2);
    expect(status.domains[0]).toMatchObject({
      domain: "example.com",
      defaultFrom: true,
    });
    expect(status.domains[0]?.records.map((record) => [record.type, record.status])).toEqual([
      ["MX", "ready"],
      ["SPF", "configured"],
      ["DKIM", "configured"],
      ["DMARC", "configured"],
    ]);
    expect(status.quotas).toMatchObject({
      perActorPerHour: 80,
      perActorPerDay: 400,
      maxMessageBytes: 26214400,
    });
    expect(status.deliveryHealth).toMatchObject({
      counts: { queued: 2, sending: 1, sent: 9, failed: 1, cancelled: 0 },
      failedLast24h: 1,
      lastError: "550 rejected",
    });
  });

  it("protects the admin route with config or mail admin scope", async () => {
    const app = fastify();
    await registerMailAdminRoutes(app, {
      service: new MailAdminStatusService({
        env: {},
        now: () => new Date("2026-05-21T13:00:00.000Z"),
      }),
      actorFromRequest: (request) => {
        const scopesHeader = request.headers["x-helix-scopes"];
        return {
          ...actor,
          scopes: typeof scopesHeader === "string" ? scopesHeader.split(" ") : [],
        };
      },
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/mail/config",
      headers: { "x-helix-scopes": "mail.read" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      requiredScope: "admin.config.read or mail.admin",
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/mail/config",
      headers: { "x-helix-scopes": "mail.admin" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      outboundRelay: { configured: false, status: "missing" },
    });

    await app.close();
  });

  it("allows config write actors to read mail status", () => {
    expect(canReadMailAdminStatus({ ...actor, scopes: ["admin.config.write"] })).toBe(true);
    expect(canReadMailAdminStatus({ ...actor, scopes: ["mail.admin"] })).toBe(true);
    expect(canReadMailAdminStatus({ ...actor, scopes: ["mail.read"] })).toBe(false);
  });
});
