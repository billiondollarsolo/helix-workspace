import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0199_drive_hidden_shares.sql", import.meta.url), "utf8");

describe("0199 Drive hidden shares and access requests", () => {
  it("lets members hide shared items and request owner access without prior read", () => {
    expect(migration).toContain("create table drive_hidden_shares");
    expect(migration).toContain("create table drive_access_requests");
    expect(migration).toContain("helix_drive_request_access");
    expect(migration).toContain("helix_drive_decide_access_request");
    expect(migration).toContain("Owners do not request access to their own files");
    expect(migration).toContain("Only the owner can decide an access request");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("actor_id = helix_current_actor_id()");
  });
});
