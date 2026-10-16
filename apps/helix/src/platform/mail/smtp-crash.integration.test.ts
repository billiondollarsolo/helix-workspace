import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { expect, it, vi } from "vitest";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresMailStore } from "./store.js";
import {
  MailSendService,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
} from "./outbound.js";

it.skipIf(!process.env.DATABASE_URL)(
  "holds a real SMTP acceptance after a failed database acknowledgement across worker restart",
  async () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 2, prepare: false });
    const orgId = randomUUID(),
      actorId = randomUUID();
    let received = 0;
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, _session, done) {
        stream.resume();
        stream.on("end", () => {
          received++;
          done(null, "accepted");
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await sql`insert into orgs (id, slug, display_name) values (${orgId}, ${"smtp-" + orgId}, 'SMTP recovery test')`;
      await sql`insert into actors (id, org_id, type, email, display_name) values (${actorId}, ${orgId}, 'user', 'sender@recovery.test', 'Recovery test')`;
      await sql`insert into admin_domains (org_id, domain, status, verification_host, verification_value, verification_expires_at, identity_enabled, mail_enabled, verified_at, is_primary) values (${orgId}, 'recovery.test', 'verified', '_test.recovery.test', 'test', now()+interval '1 day', true, true, now(), true)`;
      const store = new PostgresMailStore(tenantAwarePostgresSql(sql));
      const now = new Date();
      const queued = await withTenantPostgresContext(sql, { orgId, actorId }, () =>
        new MailSendService({ store, undoWindowMs: 0 }).queue({
          orgId,
          actorId,
          now,
          envelope: {
            from: { address: "sender@recovery.test" },
            to: [{ address: "receiver@recovery.test" }],
            cc: [],
            bcc: [],
            subject: "Isolated SMTP crash drill",
            text: "Never leaves this test SMTP server.",
            attachments: [],
          },
        }),
      );
      const failure = vi
        .spyOn(store, "markOutboundSent")
        .mockRejectedValueOnce(new Error("simulated crash after SMTP acceptance"));
      const transport = new NodemailerMailTransport({
        host: "127.0.0.1",
        port: (server.server.address() as AddressInfo).port,
        requireTls: false,
      });
      const dispatcher = new OutboundMailDispatcher(store, async () => transport, {
        runForTenant: (orgId, operation) => withTenantPostgresContext(sql, { orgId }, operation),
      });
      await expect(
        new OutboundMailWorker({
          store,
          dispatcher,
          owner: "before-crash",
          leaseMs: 1000,
        }).drainOnce(now),
      ).rejects.toThrow("simulated crash");
      failure.mockRestore();
      await new OutboundMailWorker({
        store,
        dispatcher,
        owner: "after-crash",
        leaseMs: 1000,
      }).drainOnce(new Date(now.getTime() + 1001));
      expect(received).toBe(1);
      expect(await store.listDeadLetteredOutbound(orgId)).toEqual([
        expect.objectContaining({
          id: queued.id,
          status: "failed",
          lastError: expect.stringContaining("outcome unknown"),
        }),
      ]);
      expect(await store.retryOutbound({ orgId, actorId, id: queued.id })).toBeNull();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await sql`delete from orgs where id=${orgId}`;
      await sql.end();
    }
  },
  30000,
);
