import type { EditorsCoreAppModule } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";

describe("migration source resolution", () => {
  it("uses the migrator's intentional environment and skips editor migrations", async () => {
    const migrationEnv = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://helix_migrator:test@postgres:5432/helix",
      HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
    });
    const loadEditors = vi.fn(async (): Promise<EditorsCoreAppModule | null> => null);

    const sources = await resolvePlatformMigrationSources(migrationEnv, loadEditors);

    expect(sources.map((source) => source.namespace)).toEqual(["platform"]);
    expect(loadEditors).not.toHaveBeenCalled();
  });
});
