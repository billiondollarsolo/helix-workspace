import { accountPreferencesSetInputSchema } from "@helix/contracts";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresDriveStore } from "../drive/index.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { createToolRegistry } from "../tool-registry.js";
import {
  PostgresAccountPreferencesStore,
  registerAccountPreferenceTools,
} from "./account-preferences.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip = skipUnlessLiveDatabase("Account preferences through the runtime role");

describe.skipIf(skip)("account preferences", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const store = new PostgresAccountPreferencesStore(app);
  const orgId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();

  beforeAll(async () => {
    if (adminUrl === undefined || appUrl === undefined)
      throw new Error("Account preference tests require migration and app database URLs.");
    await admin`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Prefs')`;
    for (const actorId of [alice, bob]) {
      await admin`insert into actors (id, org_id, type, email, display_name)
        values (${actorId}, ${orgId}, 'user', ${`${actorId}@example.test`}, 'Member')`;
    }
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("defaults, adopts the browser zone once, and keeps explicit choices per member", async () => {
    expect(await store.get({ orgId, actorId: alice })).toEqual({
      language: null,
      timeZone: null,
      dateFormat: null,
      timeFormat: null,
      weekStart: null,
      workingHours: null,
      mail: { readingPane: "none", density: "default", conversationView: true },
      updatedAt: null,
    });
    await new PostgresDriveStore(app).setDocumentSurfaceView({
      orgId,
      actorId: alice,
      view: "list",
    });

    expect(
      await store.set({ orgId, actorId: alice, detectedTimeZone: "Europe/Paris" }),
    ).toMatchObject({ timeZone: "Europe/Paris" });
    expect(
      await store.set({ orgId, actorId: alice, detectedTimeZone: "America/New_York" }),
    ).toMatchObject({ timeZone: "Europe/Paris" });

    const workingHours = {
      enabled: true,
      days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:30" })),
    };
    const saved = await store.set({
      orgId,
      actorId: alice,
      language: "pt-BR",
      timeZone: "Asia/Tokyo",
      dateFormat: "dmy",
      timeFormat: "24h",
      weekStart: 1,
      workingHours,
      mail: { readingPane: "right", density: "compact" },
    });
    expect(saved).toMatchObject({
      language: "pt-BR",
      timeZone: "Asia/Tokyo",
      dateFormat: "dmy",
      timeFormat: "24h",
      weekStart: 1,
      workingHours,
      mail: { readingPane: "right", density: "compact", conversationView: true },
    });
    expect(
      await store.set({ orgId, actorId: alice, language: null, mail: { conversationView: false } }),
    ).toMatchObject({
      language: null,
      timeZone: "Asia/Tokyo",
      mail: { readingPane: "right", density: "compact", conversationView: false },
    });
    expect(
      await new PostgresDriveStore(app).getDocumentSurfaceView({ orgId, actorId: alice }),
    ).toBe("list");
    expect(await store.get({ orgId, actorId: bob })).toMatchObject({ timeZone: null });
  });

  it("exposes get and set as profile-scoped tools with validated input", async () => {
    const registry = createToolRegistry();
    registerAccountPreferenceTools(registry, { store });
    const actor = {
      id: bob,
      orgId,
      type: "user" as const,
      scopes: ["profile.read", "profile.write"],
    };

    expect(
      await registry.invoke("account.preferences.set", { timeZone: "Mars/Olympus" }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(
      await registry.invoke("account.preferences.set", { weekStart: 6 }, { actor }),
    ).toMatchObject({ ok: true, output: { weekStart: 6 } });
    expect(await registry.invoke("account.preferences.get", {}, { actor })).toMatchObject({
      ok: true,
      output: { weekStart: 6 },
    });
    expect(
      await registry.invoke(
        "account.preferences.get",
        {},
        { actor: { ...actor, scopes: ["mail.read"] } },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(
      accountPreferencesSetInputSchema.safeParse({
        workingHours: { enabled: true, days: [{ day: 1, start: "18:00", end: "09:00" }] },
      }).success,
    ).toBe(false);
  });
});
