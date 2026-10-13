import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0226_drive_access_requests.sql", import.meta.url),
  "utf8",
);

describe("0226 Drive hidden shares and access requests", () => {
  it("lets members hide shared items and request owner access without prior read", () => {
    expect(migration).toContain("create table drive_hidden_shares");
    expect(migration).toContain("create table drive_access_requests");
    expect(migration).toContain("helix_drive_request_access");
    expect(migration).toContain("helix_drive_decide_access_request");
    expect(migration).toContain("Owners do not request access to their own files");
    expect(migration).toContain("Only the owner can decide an access request");
    expect(migration).toContain("force row level security");
    // Production refuses to start unless every tenant table also has the restrictive boundary.
    expect(migration.match(/create policy helix_tenant_boundary on \w+ as restrictive/gu)).toEqual([
      "create policy helix_tenant_boundary on drive_hidden_shares as restrictive",
      "create policy helix_tenant_boundary on drive_access_requests as restrictive",
    ]);
    expect(migration).toContain("actor_id = helix_current_actor_id()");
    // The application reads requests; only the two functions write them.
    expect(migration).toContain("grant select on drive_access_requests to helix_app");
    expect(migration).not.toMatch(/grant [^;]*(insert|update)[^;]* on drive_access_requests/u);
  });
});
