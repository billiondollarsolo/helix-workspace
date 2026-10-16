import type postgres from "postgres";
import { env, runtimeEnvironment } from "../config/env.js";
import { loadDriveConfig } from "../platform/drive/config.js";
import { createVaultTenantSecretReaderFromEnv } from "../platform/secrets/index.js";
import { PostgresOrgStore } from "../platform/tenancy/orgs.js";
import {
  createS3CompatibleStorage,
  createTenantStorageResolver,
  operatorStorageFetch,
} from "../platform/storage/index.js";

/** Operator commands use the same tenant routing, encryption and secret backend as the API. */
export function createOperatorStorageResolver(sql: postgres.Sql) {
  const environment = env();
  const { storage } = loadDriveConfig(environment);
  const orgs = new PostgresOrgStore(sql, environment.HELIX_REGION);
  const defaultClient =
    storage.endpoint === undefined
      ? undefined
      : createS3CompatibleStorage({
          ...storage,
          endpoint: storage.endpoint,
          fetch: operatorStorageFetch(storage.endpoint),
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
        });
  return createTenantStorageResolver({
    defaultClient,
    defaultServerSideEncryption: storage.serverSideEncryption,
    loadByoConfig: async (orgId) => (await orgs.findById(orgId))?.byoConfig,
    secretReader: createVaultTenantSecretReaderFromEnv(runtimeEnvironment()),
    ...(environment.HELIX_REGION === "default"
      ? {}
      : { deploymentRegion: environment.HELIX_REGION }),
  });
}
