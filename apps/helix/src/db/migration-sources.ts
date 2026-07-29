import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditorsCoreAppModule } from "@helix/sdk-types";
import { loadEnv, type Env } from "../config/env.js";
import {
  loadEditorsCoreAppModule,
  type EditorsCoreAppImporter,
} from "../platform/editors/core-app.js";
import type { MigrationSource } from "./migration-runner.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

type MigrationSourceEnvironment = Pick<
  Env,
  | "HELIX_EDITORS_MIGRATIONS_ENABLED"
  | "HELIX_EDITORS_CORE_APP_ENTRY"
  | "HELIX_EDITORS_CORE_APP_MODULE"
>;

type EditorsModuleLoader = (
  specifier?: string,
  importer?: EditorsCoreAppImporter,
) => Promise<EditorsCoreAppModule | null>;

export async function resolvePlatformMigrationSources(
  migrationEnv: MigrationSourceEnvironment = loadEnv(),
  loadEditors: EditorsModuleLoader = loadEditorsCoreAppModule,
): Promise<readonly MigrationSource[]> {
  const sources: MigrationSource[] = [
    {
      namespace: "platform",
      directory: join(currentDir, "migrations"),
    },
  ];
  const editorsMigrationSource = await resolveEditorsMigrationSource(migrationEnv, loadEditors);
  if (editorsMigrationSource !== null) {
    sources.push(editorsMigrationSource);
  }
  return sources;
}

async function resolveEditorsMigrationSource(
  migrationEnv: MigrationSourceEnvironment,
  loadEditors: EditorsModuleLoader,
): Promise<MigrationSource | null> {
  if (migrationEnv.HELIX_EDITORS_MIGRATIONS_ENABLED === "false") {
    return null;
  }
  const specifier =
    migrationEnv.HELIX_EDITORS_CORE_APP_ENTRY ??
    migrationEnv.HELIX_EDITORS_CORE_APP_MODULE ??
    "@helix/editors-core-app";
  const module = await loadEditors(specifier);
  const source = module?.getEditorsMigrationSource?.();
  if (source !== undefined) {
    return source;
  }
  const directory = module?.resolveEditorsMigrationDir?.();
  return directory === undefined ? null : { namespace: "editors", directory };
}
