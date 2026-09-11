import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0200_agent_defender.sql", import.meta.url), "utf8");

describe("0200 Agent Defender", () => {
  it("adds held mail, per-agent receive policy, and owner-only hold decisions", () => {
    expect(migration).toContain("add column if not exists held_at timestamptz");
    expect(migration).toContain("create table agent_defender_policies");
    expect(migration).toContain("receive_mode text not null default 'allowlist'");
    expect(migration).toContain("create table agent_defender_jobs");
    expect(migration).toContain("same pattern as assistant_routines");
    expect(migration).toContain("helix_agent_defender_set_hold");
    expect(migration).toContain("helix_agent_defender_list_holds");
    expect(migration).toContain("#variable_conflict use_column");
    expect(migration).toContain("Only the agent owner can decide held mail");
    expect(migration).toContain("force row level security");
  });
});
