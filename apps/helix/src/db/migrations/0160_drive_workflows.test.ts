import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0160_drive_workflows.sql", import.meta.url), "utf8");

describe("0160 Drive workflows migration", () => {
  it("uses one tenant/actor-bound state machine for governed Drive workflows", () => {
    for (const kind of [
      "shortcut",
      "file_request",
      "approval",
      "ownership_transfer",
      "shared_drive",
      "classification",
      "hold",
      "investigation",
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).toContain("version bigint not null default 1");
    expect(migration).toContain("new.version := old.version + 1");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("requested_by_actor_id = helix_current_actor_id()");
    expect(migration).toContain("Drive workflow object must belong to its tenant");
    expect(migration).toContain("policy_snapshot jsonb not null");
    expect(migration).toContain("Drive workflow identity and policy snapshot are immutable");
    expect(migration).toContain("Drive workflow transition actor is invalid");
    expect(migration).toContain("Drive workflow transition is invalid for its kind");
    expect(migration).toContain("helix_drive_apply_ownership_transfer");
  });
});
