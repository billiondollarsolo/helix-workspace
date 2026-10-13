import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import {
  tenantAwarePostgresSql,
  withRequesterPostgresActor,
  withTenantPostgresContext,
} from "./postgres-roles.js";

/**
 * Approved work runs as whoever asked for it. Inside the approver's request
 * transaction the database identity becomes the requester for the duration of
 * the work, and is the approver's again afterwards, whether the work succeeds
 * or fails.
 */

const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Running approved work as its requester") || appUrl === undefined;

describe.skipIf(skip)("withRequesterPostgresActor", () => {
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const orgId = randomUUID();
  const approver = randomUUID();
  const agent = randomUUID();
  const whoAmI = async () =>
    (await app<{ actor: string | null }[]>`select helix_current_actor_id()::text as actor`)[0]
      ?.actor;

  afterAll(() => app.end());

  it("is the requester during the work and the approver again after it", async () => {
    await withTenantPostgresContext(app, { orgId, actorId: approver }, async () => {
      expect(await whoAmI()).toBe(approver);
      await expect(withRequesterPostgresActor(agent, whoAmI)).resolves.toBe(agent);
      expect(await whoAmI()).toBe(approver);
      // Work nested inside may name the requester, and only the requester.
      await withRequesterPostgresActor(agent, async () => {
        await expect(
          withTenantPostgresContext(app, { orgId, actorId: agent }, whoAmI),
        ).resolves.toBe(agent);
        await expect(
          withTenantPostgresContext(app, { orgId, actorId: approver }, whoAmI),
        ).rejects.toThrow("cannot switch actor context");
      });
      expect(await whoAmI()).toBe(approver);
    });
  });

  it("returns to the approver when the work fails, leaving the request usable", async () => {
    await withTenantPostgresContext(app, { orgId, actorId: approver }, async () => {
      await expect(
        withRequesterPostgresActor(agent, async () => {
          await app`select 1 from a_table_that_does_not_exist`;
        }),
      ).rejects.toThrow();
      expect(await whoAmI()).toBe(approver);
    });
  });

  it("does nothing special when a person confirms their own action", async () => {
    await withTenantPostgresContext(app, { orgId, actorId: approver }, async () => {
      await expect(withRequesterPostgresActor(approver, whoAmI)).resolves.toBe(approver);
    });
    // Outside a request there is no identity to borrow or restore.
    await expect(withRequesterPostgresActor(agent, async () => "ran")).resolves.toBe("ran");
  });
});
