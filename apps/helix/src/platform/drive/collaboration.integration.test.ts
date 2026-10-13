import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { DriveShareMailer } from "./share-mail.js";
import { PostgresDriveStore } from "./store.js";

/**
 * Sharing as the people on the receiving end see it, under the runtime
 * database role: being told about a share, asking for access to an item you
 * cannot open, the owner's answer, and hiding a shared item.
 */

const ORG = "d5c00000-0000-4000-8000-000000000001";
const OWNER = "d5c00000-0000-4000-8000-000000000011";
const READER = "d5c00000-0000-4000-8000-000000000012";
const ASKER = "d5c00000-0000-4000-8000-000000000013";
const skip = skipUnlessLiveDatabase("Drive sharing notifications and access requests");

describe("Drive sharing notifications and access requests", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_drive_collab");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  let runtime: postgres.Sql;
  let drive: PostgresDriveStore;
  const mail: string[] = [];
  const mailer: DriveShareMailer = {
    sendShare: async (input) => {
      mail.push(`share:${input.title}:${input.recipients.map((to) => to.email).join(",")}`);
    },
    sendAccessRequest: async (input) => {
      mail.push(`request:${input.title}:${input.ownerEmail}`);
    },
    sendAccessDecision: async (input) => {
      mail.push(
        `${input.approved ? "approved" : "declined"}:${input.title}:${input.requesterEmail}`,
      );
    },
    sendComment: async () => undefined,
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, [ORG]);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name) values (${ORG}, 'drive-collab', 'Collab')`;
    await admin`
      insert into actors (id, org_id, type, email, display_name) values
        (${OWNER}, ${ORG}, 'user', 'owner@drive-collab.test', 'Olu Owner'),
        (${READER}, ${ORG}, 'user', 'reader@drive-collab.test', 'Rae Reader'),
        (${ASKER}, ${ORG}, 'user', 'asker@drive-collab.test', 'Ash Asker')
    `;
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 4, prepare: false });
    runtime = tenantAwarePostgresSql(runtimeRaw);
    drive = new PostgresDriveStore(runtime, undefined, { shareMailer: mailer });
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, [ORG]);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  const as = <T>(actorId: string, run: () => Promise<T>) =>
    withTenantPostgresContext(runtime, { orgId: ORG, actorId }, run);
  const folder = (name: string) =>
    as(OWNER, () => drive.createFolder({ orgId: ORG, actorId: OWNER, name, parentFolderId: null }));
  const notices = async (actorId: string) =>
    (
      await admin<{ verb: string; summary: string }[]>`
        select verb, summary from notifications
        where org_id = ${ORG} and actor_id = ${actorId} order by created_at, id
      `
    ).map((row) => `${row.verb}: ${row.summary}`);
  const sharedWith = async (actorId: string) =>
    (await as(actorId, () => drive.list({ orgId: ORG, actorId, view: "shared" }))).entries.map(
      (entry) => entry.name,
    );

  it("tells a person once that an item was shared with them, and emails only when asked", async () => {
    const handbook = await folder("Handbook");
    const share = (notify: boolean) =>
      as(OWNER, () =>
        drive.share({
          orgId: ORG,
          actorId: OWNER,
          objectId: handbook.id,
          targetActorIds: [READER],
          role: "reader",
          notify,
          message: "For Monday",
        }),
      );
    await share(false);
    expect(await notices(READER)).toEqual([
      'drive.object.shared: Olu Owner shared "Handbook" with you.',
    ]);
    expect(mail).toEqual([]);
    // Sharing again with someone who already has access tells nobody anything.
    await share(true);
    expect(await notices(READER)).toHaveLength(1);
    expect(mail).toEqual([]);

    const plans = await folder("Plans");
    await as(OWNER, () =>
      drive.share({
        orgId: ORG,
        actorId: OWNER,
        objectId: plans.id,
        targetActorIds: [READER],
        role: "reader",
        notify: true,
      }),
    );
    expect(mail).toEqual(["share:Plans:reader@drive-collab.test"]);
  });

  it("lets a person hide an item shared with them without losing access", async () => {
    const shared = await sharedWith(READER);
    expect(shared).toEqual(["Handbook", "Plans"]);
    const handbook = (
      await as(READER, () => drive.list({ orgId: ORG, actorId: READER, view: "shared" }))
    ).entries.find((entry) => entry.name === "Handbook");
    if (handbook === undefined) throw new Error("Handbook should be shared.");
    const hide = (hidden: boolean) =>
      as(READER, () =>
        drive.setHiddenShare({ orgId: ORG, actorId: READER, objectId: handbook.id, hidden }),
      );
    await hide(true);
    expect(await sharedWith(READER)).toEqual(["Plans"]);
    // Still openable: hiding is a view of the list, not a change of access.
    await expect(
      as(READER, () => drive.list({ orgId: ORG, actorId: READER, folderId: handbook.id })),
    ).resolves.toMatchObject({ entries: [] });
    await hide(false);
    expect(await sharedWith(READER)).toEqual(["Handbook", "Plans"]);
    // A person cannot hide what was never shared with them.
    await expect(
      as(ASKER, () =>
        drive.setHiddenShare({ orgId: ORG, actorId: ASKER, objectId: handbook.id, hidden: true }),
      ),
    ).rejects.toThrow();
  });

  it("carries a request for access to the owner, who alone can answer it", async () => {
    mail.length = 0;
    const budget = await folder("Budget");
    const ask = (actorId: string, message?: string) =>
      as(actorId, () => drive.requestAccess({ orgId: ORG, actorId, objectId: budget.id, message }));
    const { requestId } = await ask(ASKER, "Need it for the review");
    // Asking again keeps the one open request and does not tell the owner twice.
    await expect(ask(ASKER)).resolves.toEqual({ requestId });
    // The owner, and people who already have access, have nothing to ask for.
    await expect(ask(OWNER)).rejects.toThrow(/own files/u);

    expect(await notices(OWNER)).toEqual([
      'drive.access.requested: Ash Asker asked for access to "Budget".',
    ]);
    const open = await as(OWNER, () => drive.listAccessRequests({ orgId: ORG, actorId: OWNER }));
    expect(open).toMatchObject([
      {
        id: requestId,
        objectId: budget.id,
        objectName: "Budget",
        requesterDisplayName: "Ash Asker",
        message: "Need it for the review",
      },
    ]);
    // Nobody else sees the request or can answer it, the person asking included.
    await expect(
      as(READER, () => drive.listAccessRequests({ orgId: ORG, actorId: READER })),
    ).resolves.toEqual([]);
    for (const actorId of [READER, ASKER]) {
      await expect(
        as(actorId, () =>
          drive.decideAccessRequest({ orgId: ORG, actorId, requestId, approve: true }),
        ),
      ).rejects.toThrow();
    }
    expect(await sharedWith(ASKER)).toEqual([]);

    await as(OWNER, () =>
      drive.decideAccessRequest({ orgId: ORG, actorId: OWNER, requestId, approve: true }),
    );
    expect(await sharedWith(ASKER)).toEqual(["Budget"]);
    expect(await notices(ASKER)).toEqual([
      'drive.access.approved: Olu Owner gave you access to "Budget".',
    ]);
    expect(mail).toEqual([
      "request:Budget:owner@drive-collab.test",
      "approved:Budget:asker@drive-collab.test",
    ]);
    await expect(ask(ASKER)).rejects.toThrow(/already has access/u);
    // An answered request cannot be answered again.
    await expect(
      as(OWNER, () =>
        drive.decideAccessRequest({ orgId: ORG, actorId: OWNER, requestId, approve: false }),
      ),
    ).rejects.toThrow(/no longer open/u);
  });

  it("asks the item's owner at the time of the answer, not the time of the request", async () => {
    const archive = await folder("Archive");
    const { requestId } = await as(ASKER, () =>
      drive.requestAccess({ orgId: ORG, actorId: ASKER, objectId: archive.id }),
    );
    await admin`update drive_folders set owner_actor_id = ${READER} where id = ${archive.id}`;
    await expect(
      as(OWNER, () =>
        drive.decideAccessRequest({ orgId: ORG, actorId: OWNER, requestId, approve: true }),
      ),
    ).rejects.toThrow(/Only the owner/u);
    expect(await sharedWith(ASKER)).toEqual(["Budget"]);
  });
});
