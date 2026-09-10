import { coercePositiveInt, optionalString } from "./common.js";
export const observabilityEnv = {
  AUDIT_IMMUTABLE_S3_ENABLED: optionalString,
  AUDIT_IMMUTABLE_S3_ACCESS_KEY: optionalString,
  AUDIT_IMMUTABLE_S3_SECRET_KEY: optionalString,
  AUDIT_VERIFIER_INTERVAL_MS: coercePositiveInt(86400000),
  AUDIT_WORM_POSTGRES_ENABLED: optionalString,
  OTEL_SDK_DISABLED: optionalString,
  HELIX_OTEL_REGION: optionalString,
  AUDIT_IMMUTABLE_S3_REGION: optionalString,
};
