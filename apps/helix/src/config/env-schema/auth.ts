import { z } from "zod";
import { coercePositiveInt, optionalString, optionalUrl } from "./common.js";
export const authEnv = {
  HELIX_TENANT_ROOT_HOSTS: optionalString,
  HELIX_TENANT_PROXY_SECRET: optionalString.pipe(z.string().min(32).optional()),
  HELIX_TENANT_STORAGE_MIGRATION_INTERVAL_MS: coercePositiveInt(15000),
  HELIX_TENANT_STORAGE_MIGRATION_BATCH_SIZE: coercePositiveInt(2),
  BETTER_AUTH_SECRET: optionalString,
  BETTER_AUTH_ENABLED: optionalString,
  BETTER_AUTH_URL: optionalUrl,
  BETTER_AUTH_DATABASE_URL: optionalUrl,
  BETTER_AUTH_TRUSTED_ORIGINS: optionalString,
  HELIX_MFA_ASSERTION_SECRET: optionalString,
  HELIX_MFA_ASSERTION_ISSUER: optionalString,
  HELIX_MFA_ASSERTION_AUDIENCE: optionalString,
  CERBOS_HTTP_URL: optionalUrl,
};
