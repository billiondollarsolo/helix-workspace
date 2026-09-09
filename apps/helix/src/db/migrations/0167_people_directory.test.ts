import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0167 people directory", () => {
  it("adds bounded contact annotations and tenant enforcement", async () => {
    const migration = await readFile(
      new URL("./0167_people_directory.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("favorite boolean not null default false");
    expect(migration).toContain("octet_length(avatar_data_url) <= 350000");
    expect(migration).toContain("merged_into_id uuid references carddav_contacts(id)");
    expect(migration).toContain("helix_validate_people_contact_tenant");
    expect(migration).toContain("force row level security");
  });
});
