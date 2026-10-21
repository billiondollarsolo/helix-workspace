import { z } from "zod";
import { coercePositiveInt, optionalString, optionalUrl } from "./common.js";
export const authEnv = {
  HELIX_FEDERATION_IDENTITY_ENABLED: optionalString.pipe(z.enum(["true", "false"]).optional()),
  HELIX_FEDERATION_ALLOW_PRIVATE_NETWORK: optionalString.pipe(z.enum(["true", "false"]).optional()),
  // "public.host=target:port[,...]": reach a federated app over a private network
  // (Docker, VPC, Tailscale) while still verifying its public hostname's TLS identity.
  HELIX_FEDERATION_ROUTES: optionalString.pipe(
    z
      .string()
      .regex(
        /^[a-z0-9.-]+=[A-Za-z0-9.-]+:\d{1,5}(,[a-z0-9.-]+=[A-Za-z0-9.-]+:\d{1,5})*$/u,
        "Use public.host=target:port, separated by commas.",
      )
      .optional(),
  ),
  HELIX_BOOTSTRAP_ADMIN_ENABLED: optionalString.pipe(z.enum(["true", "false"]).optional()),
  HELIX_BOOTSTRAP_ADMIN_EMAIL: optionalString,
  HELIX_BOOTSTRAP_ADMIN_NAME: optionalString,
  HELIX_BOOTSTRAP_ADMIN_PASSWORD_FILE: optionalString,
  HELIX_BOOTSTRAP_ADMIN_STATE_DIRECTORY: optionalString,
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
