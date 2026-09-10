import type postgres from "postgres";
import { type VirusScanner } from "../scanning.js";
import { type DriveStorageClient, type PostgresDriveStoreOptions } from "./contracts.js";
export interface DriveStoreContext {
  readonly sql: postgres.Sql;
  readonly storage: DriveStorageClient | undefined;
  readonly options: PostgresDriveStoreOptions;
  readonly virusScanner: VirusScanner;
  virusScanOrgCursor: string | undefined;
  readonly nextBlobReconciliation: Map<string, number>;
}
