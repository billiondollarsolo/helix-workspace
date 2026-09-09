import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationSource } from "./migration-runner.js";

export function resolvePlatformMigrationSources(): Promise<readonly MigrationSource[]> {
  return Promise.resolve([
    {
      namespace: "platform",
      directory: join(dirname(fileURLToPath(import.meta.url)), "migrations"),
    },
  ]);
}
