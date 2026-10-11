import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  setTenantPostgresActorId,
  withTenantPostgresContext,
} from "../../tenancy/postgres-roles.js";
import { afterReplySafe, registerDriveS3Gateway, type DriveS3GatewayOptions } from "./gateway.js";

const ORG_ID = "5a3e0000-0000-4000-8000-0000000000c1";
const ACTOR_ID = "5a3e0000-0000-4000-8000-0000000000c2";

/** A client whose transaction accepts any query, enough to enter a tenant context. */
function fakeSql(): postgres.Sql {
  const tx = (async () => []) as unknown as postgres.TransactionSql;
  return {
    begin: async (callback: (transaction: postgres.TransactionSql) => Promise<unknown>) =>
      callback(tx),
  } as unknown as postgres.Sql;
}

describe("Drive S3 gateway post-reply work", () => {
  it("stays in the request transaction until the reply is sent", async () => {
    await withTenantPostgresContext(fakeSql(), { orgId: ORG_ID }, async () => {
      // The actor binds to the still-open request transaction.
      await expect(
        afterReplySafe({ sent: false }, () => setTenantPostgresActorId(ACTOR_ID)),
      ).resolves.toBe(true);
    });
  });

  it("leaves the committed request transaction once the reply is sent", async () => {
    await withTenantPostgresContext(fakeSql(), { orgId: ORG_ID }, async () => {
      // Sending the reply commits the request transaction, so audit writes must
      // not open a savepoint on it: no tenant transaction is active here.
      await expect(
        afterReplySafe({ sent: true }, () => setTenantPostgresActorId(ACTOR_ID)),
      ).resolves.toBe(false);
    });
  });
});

describe("Drive S3 gateway errors", () => {
  it("keeps the XML error body when an onSend hook is slow, like the tenant commit", async () => {
    const app = fastify();
    // Like the tenancy hook: the first onSend commits the request transaction
    // (slow); any later one finds nothing left to commit and returns at once.
    let committed = false;
    app.addHook("onSend", async (_request, _reply, payload) => {
      if (!committed) {
        committed = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return payload;
    });
    // An anonymous request is refused before any store is touched.
    await registerDriveS3Gateway(app, {
      isEnabled: () => true,
    } as unknown as DriveS3GatewayOptions);

    const response = await app.inject({ method: "GET", url: "/s3/my-drive" });

    expect(response.statusCode).toBe(403);
    expect(response.headers["x-amz-error-code"]).toBe("AccessDenied");
    expect(response.body).toContain("<Code>AccessDenied</Code>");
    expect(response.body).toContain("Anonymous access is not allowed.");
    await app.close();
  });
});
