import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { loadEditorsCoreAppModule } from "../platform/editors/core-app.js";
import type { MigrationSource } from "./migration-runner.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

export async function resolvePlatformMigrationSources(): Promise<readonly MigrationSource[]> {
  const sources: MigrationSource[] = [
    {
      namespace: "platform",
      directory: join(currentDir, "migrations"),
    },
  ];
  const editorsMigrationSource = await resolveEditorsMigrationSource();
  if (editorsMigrationSource !== null) {
    sources.push(editorsMigrationSource);
  }
  return sources;
}

async function resolveEditorsMigrationSource(): Promise<MigrationSource | null> {
  const bootEnv = env();
  if (bootEnv.HELIX_EDITORS_MIGRATIONS_ENABLED === "false") {
    return null;
  }
  const specifier =
    bootEnv.HELIX_EDITORS_CORE_APP_ENTRY ??
    bootEnv.HELIX_EDITORS_CORE_APP_MODULE ??
    "@helix/editors-core-app";
  const module = await loadEditorsCoreAppModule(specifier);
  const source = module?.getEditorsMigrationSource?.();
  if (source !== undefined) {
    return source;
  }
  const directory = module?.resolveEditorsMigrationDir?.();
  return directory === undefined ? null : { namespace: "editors", directory };
}
