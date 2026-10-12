import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresDriveStore } from "./store.js";

const ORG = "d5a70000-0000-4000-8000-000000000001";
const OWNER = "d5a70000-0000-4000-8000-000000000011";
const READER = "d5a70000-0000-4000-8000-000000000012";
const skip = skipUnlessLiveDatabase("Drive Shared with me");

describe("Drive Shared with me", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_drive_shared");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  let drive: PostgresDriveStore;
  let runtime: postgres.Sql;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, [ORG]);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name) values (${ORG}, 'drive-shared', 'Shared')`;
    await admin`
      insert into actors (id, org_id, type, email, display_name) values
        (${OWNER}, ${ORG}, 'user', 'owner@drive-shared.test', 'Owner'),
        (${READER}, ${ORG}, 'user', 'reader@drive-shared.test', 'Reader')
    `;
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 4, prepare: false });
    runtime = tenantAwarePostgresSql(runtimeRaw);
    drive = new PostgresDriveStore(runtime);
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, [ORG]);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  const as = <T>(actorId: string, run: () => Promise<T>) =>
    withTenantPostgresContext(runtime, { orgId: ORG, actorId }, run);
  const folder = (name: string, parentFolderId: string | null = null) =>
    as(OWNER, () => drive.createFolder({ orgId: ORG, actorId: OWNER, name, parentFolderId }));
  const shareWithReader = (objectId: string) =>
    as(OWNER, () =>
      drive.share({
        orgId: ORG,
        actorId: OWNER,
        objectId,
        targetActorIds: [READER],
        role: "reader",
      }),
    );

  it("lists folders shared from anywhere in the owner's tree, but not their contents", async () => {
    const projects = await folder("Projects");
    const roadmap = await folder("Roadmap", projects.id);
    await folder("Drafts", roadmap.id);
    const handbook = await folder("Handbook");
    await folder("Private", projects.id);
    await shareWithReader(roadmap.id);
    await shareWithReader(handbook.id);

    const shared = await as(READER, () =>
      drive.list({ orgId: ORG, actorId: READER, view: "shared" }),
    );
    expect(shared.entries.map((entry) => entry.name)).toEqual(["Handbook", "Roadmap"]);

    // The owner sees neither in their own Shared with me, and only roots in My Drive.
    const owned = await as(OWNER, () => drive.list({ orgId: ORG, actorId: OWNER, view: "owned" }));
    expect(owned.entries.map((entry) => entry.name)).toEqual(["Handbook", "Projects"]);
    const ownerShared = await as(OWNER, () =>
      drive.list({ orgId: ORG, actorId: OWNER, view: "shared" }),
    );
    expect(ownerShared.entries).toEqual([]);

    // Opening a shared folder lists its children as usual.
    const inside = await as(READER, () =>
      drive.list({ orgId: ORG, actorId: READER, folderId: roadmap.id }),
    );
    expect(inside.entries.map((entry) => entry.name)).toEqual(["Drafts"]);
  });
});
