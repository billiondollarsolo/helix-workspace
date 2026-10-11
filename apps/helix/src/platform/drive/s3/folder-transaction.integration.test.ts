import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { PostgresDriveStore } from "../store.js";
import { DRIVE_S3_BUCKETS } from "./buckets.js";
import { ensureDriveS3Folders, type DriveS3Access } from "./drive-access.js";
import { createDriveS3FolderTransaction } from "./folder-transaction.js";

const SKIP = skipUnlessLiveDatabase("Drive S3 prefix folders under concurrent uploads");
const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const ORG = "5a3f0000-0000-4000-8000-00000000000a";
const OWNER = "5a3f0000-0000-4000-8000-0000000000a1";
const EDITOR = "5a3f0000-0000-4000-8000-0000000000a2";

function person(id: string): Actor {
  return { id, orgId: ORG, type: "user", scopes: ["drive.read", "drive.write"] };
}

describe.skipIf(SKIP)("Drive S3 prefix folders under concurrent uploads", () => {
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  const runtime = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 10, prepare: false }));
  const drive = new PostgresDriveStore(runtime);
  const folderTransaction = createDriveS3FolderTransaction(runtime);
  let teamFolderId = "";

  /** One S3 request's folder access, as the gateway builds it. */
  function access(actorId: string, bucket: "my-drive" | "shared-with-me"): DriveS3Access {
    return {
      store: drive,
      actor: person(actorId),
      bucket: DRIVE_S3_BUCKETS[bucket],
      traceId: `trace-${actorId}`,
      inOwnTransaction: (work) => folderTransaction({ orgId: ORG, actorId }, work),
    };
  }

  beforeAll(async () => {
    await cleanupTestTenants(admin, [ORG]);
    await admin`insert into orgs (id, slug, display_name) values (${ORG}, 's3-folder-race', 'S3 race')`;
    await withTenantPostgresContext(
      admin,
      { orgId: ORG },
      (tx) => tx`
        insert into actors (id, org_id, type, display_name, email, scopes)
        values
          (${OWNER}, ${ORG}, 'user', 'Owner', 'owner@s3-folder-race.test',
            ${tx.array(["drive.read", "drive.write"])}),
          (${EDITOR}, ${ORG}, 'user', 'Editor', 'editor@s3-folder-race.test',
            ${tx.array(["drive.read", "drive.write"])})
      `,
    );
    teamFolderId = await withTenantPostgresContext(
      runtime,
      { orgId: ORG, actorId: OWNER },
      async () => {
        const team = await drive.createFolder({
          orgId: ORG,
          actorId: OWNER,
          name: "Team",
          parentFolderId: null,
        });
        await drive.share({
          orgId: ORG,
          actorId: OWNER,
          objectId: team.id,
          targetActorIds: [EDITOR],
          role: "editor",
        });
        return team.id;
      },
    );
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [ORG]);
    await admin.end();
    await runtime.end();
  });

  it("creates one new folder when two people upload into it at the same time", async () => {
    for (const name of ["Q1", "Q2", "Q3"]) {
      // The owner writes through my-drive and the editor through shared-with-me;
      // both resolve "Team" and race to create the same new child.
      const created = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          index % 2 === 0
            ? ensureDriveS3Folders(access(OWNER, "my-drive"), ["Team", name])
            : ensureDriveS3Folders(access(EDITOR, "shared-with-me"), ["Team", name]),
        ),
      );

      expect(new Set(created).size).toBe(1);
      const rows = await admin<{ id: string }[]>`
        select id from drive_folders
        where org_id = ${ORG} and parent_folder_id = ${teamFolderId}
          and name = ${name} and deleted_at is null
      `;
      expect(rows.map((row) => row.id)).toEqual([created[0]]);
    }
  });
});
