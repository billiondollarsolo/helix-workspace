import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { MeteringIngestWorker } from "./ingest-worker.js";
import { PostgresMeteringEventStore } from "./store.js";

const ORG = "fe7e0000-0000-4000-8000-000000000001";
const OTHER_ORG = "fe7e0000-0000-4000-8000-000000000002";
const skip = skipUnlessLiveDatabase("Metering ingest under the runtime role");

describe("Metering ingest under the runtime role", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_metering_ingest");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  let runtime: postgres.Sql;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, [ORG, OTHER_ORG]);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`
      insert into orgs (id, slug, display_name) values
        (${ORG}, 'metering-ingest', 'Metering ingest'),
        (${OTHER_ORG}, 'metering-ingest-other', 'Metering ingest other')
    `;
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 4, prepare: false });
    runtime = tenantAwarePostgresSql(runtimeRaw);
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, [ORG, OTHER_ORG]);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("stores each drained event under its own org's tenant context", async () => {
    const bus = new InMemoryEventBus({
      onError: (error) => {
        throw error;
      },
    });
    const errors: unknown[] = [];
    const worker = new MeteringIngestWorker({
      events: bus,
      store: new PostgresMeteringEventStore(runtime),
      onError: (error) => errors.push(error),
    });
    await worker.start();

    const publish = (orgId: string, quantity: string) =>
      bus.publish(`metering.events.${orgId}`, {
        orgId,
        eventType: "ai.tokens",
        quantity,
        metadata: { source: "integration" },
      });
    // No ambient context (a drain loop), then from inside another tenant's
    // request: neither may borrow that context or its transaction.
    await publish(ORG, "11");
    await publish(OTHER_ORG, "22");
    await withTenantPostgresContext(runtime, { orgId: ORG }, () => publish(OTHER_ORG, "33"));
    await worker.stop();

    expect(errors).toEqual([]);
    const rows = await admin<{ org_id: string; quantity: string }[]>`
      select org_id, quantity::text as quantity from metering_events
      where org_id in (${ORG}, ${OTHER_ORG})
      order by quantity
    `;
    expect(rows).toEqual([
      { org_id: ORG, quantity: "11" },
      { org_id: OTHER_ORG, quantity: "22" },
      { org_id: OTHER_ORG, quantity: "33" },
    ]);
  });
});
