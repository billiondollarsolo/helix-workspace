import type { RuntimeToolRegistry } from "../tool-registry.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import { registerSheetsTools } from "./tools.js";
import type { CreateSheetsToolDefinitionsOptions, OfficeTextExtractor } from "./tools.js";
import type { SheetsStore } from "./store.js";

export * from "./store.js";
export * from "./routes.js";
export * from "./tools.js";
export * from "./types.js";

/** Options accepted by {@link registerSheets}. */
export interface RegisterSheetsOptions {
  readonly registry: RuntimeToolRegistry;
  readonly store: SheetsStore;
  readonly importSources?: CreateSheetsToolDefinitionsOptions["importSources"];
  readonly officeTextExtractor?: OfficeTextExtractor | undefined;
  /** Optional auto-classification hook for newly created spreadsheets. */
  readonly classifyResource?: ResourceClassifier | undefined;
}

/**
 * Wire the Sheets domain into the platform: registers the Sheets tools on the
 * runtime tool registry. The Sheets domain is fully tool-driven, so there are
 * no additional REST routes to mount.
 *
 * `server.ts` constructs a {@link PostgresSheetsStore} (from the shared
 * `postgres.Sql`) and calls `registerSheets({ registry: tools, store,
 * classifyResource })` alongside the other `register*` domain wiring.
 */
export function registerSheets(options: RegisterSheetsOptions): void {
  registerSheetsTools(options.registry, {
    store: options.store,
    ...(options.importSources === undefined ? {} : { importSources: options.importSources }),
    ...(options.officeTextExtractor === undefined
      ? {}
      : { officeTextExtractor: options.officeTextExtractor }),
    ...(options.classifyResource === undefined
      ? {}
      : { classifyResource: options.classifyResource }),
  });
}
