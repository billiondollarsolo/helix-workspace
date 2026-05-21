import { isJsonObject } from "./json.js";
import type { JsonObject } from "./json.js";
import type { SecurityTier } from "./config.js";

export type PluginKind = "in-process" | "external-service" | "wasm";

export interface PluginVendor {
  readonly name: string;
  readonly url?: string;
}

export interface PluginCapabilitiesDeclaration {
  readonly provides: readonly string[];
  readonly consumes: readonly string[];
}

export interface PluginDependencyDeclaration {
  readonly id: string;
  readonly version?: string;
  readonly optional?: boolean;
}

export interface PluginPermissionsDeclaration {
  readonly scopes: readonly string[];
  readonly "outbound-network": readonly string[];
  readonly filesystem: readonly string[];
  readonly envVars: readonly string[];
}

export interface PluginTierRequirements {
  readonly minTier?: SecurityTier;
  readonly tierRestrictions?: Partial<Record<SecurityTier, JsonObject | "prohibited">>;
}

export interface PluginSignatureEvidence {
  readonly bundleDigest?: string;
  readonly sigstoreBundle?: string;
  readonly signerIdentity?: string;
  readonly signedAt?: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly vendor?: PluginVendor;
  readonly license?: string;
  readonly sdkVersion: string;
  readonly kind: PluginKind;
  readonly main?: string | null;
  readonly endpoint?: string | null;
  readonly dependencies?: readonly (string | PluginDependencyDeclaration)[];
  readonly capabilities: PluginCapabilitiesDeclaration;
  readonly permissions: PluginPermissionsDeclaration;
  readonly migrations?: string | null;
  readonly policies?: string | null;
  readonly uiContribution?: JsonObject;
  readonly tierRequirements?: PluginTierRequirements;
  readonly signature?: PluginSignatureEvidence;
  readonly ai?: JsonObject;
}

export type PluginLifecycleState =
  | "discovered"
  | "validated"
  | "installed"
  | "migrating"
  | "migrated"
  | "starting"
  | "enabled"
  | "disabled"
  | "degraded"
  | "uninstalling"
  | "uninstalled";

export interface ManifestValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ManifestValidationIssue[];
}

export const pluginManifestJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://helix.local/schemas/plugin-manifest.schema.json",
  type: "object",
  required: ["id", "name", "version", "sdkVersion", "kind", "capabilities", "permissions"],
  additionalProperties: true,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9]+(\\.[a-z0-9-]+)+$" },
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    sdkVersion: { type: "string", minLength: 1 },
    kind: { enum: ["in-process", "external-service", "wasm"] },
    main: { type: ["string", "null"] },
    endpoint: { type: ["string", "null"] },
    dependencies: {
      type: "array",
      items: {
        oneOf: [
          { type: "string", minLength: 1 },
          {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1 },
              version: { type: "string" },
              optional: { type: "boolean" },
            },
          },
        ],
      },
    },
    capabilities: {
      type: "object",
      required: ["provides", "consumes"],
      properties: {
        provides: { type: "array", items: { type: "string" } },
        consumes: { type: "array", items: { type: "string" } },
      },
    },
    permissions: {
      type: "object",
      required: ["scopes", "outbound-network", "filesystem", "envVars"],
      properties: {
        scopes: { type: "array", items: { type: "string" } },
        "outbound-network": { type: "array", items: { type: "string" } },
        filesystem: { type: "array", items: { type: "string" } },
        envVars: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export function validatePluginManifest(value: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];

  if (!isJsonObject(value)) {
    return { valid: false, issues: [{ path: "$", message: "manifest must be an object" }] };
  }

  requireString(value, "id", issues);
  requireString(value, "name", issues);
  requireString(value, "version", issues);
  requireString(value, "sdkVersion", issues);

  const kind = value.kind;
  if (kind !== "in-process" && kind !== "external-service" && kind !== "wasm") {
    issues.push({ path: "$.kind", message: "kind must be in-process, external-service, or wasm" });
  }

  validateCapabilities(value.capabilities, issues);
  validatePermissions(value.permissions, issues);
  validateDependencies(value.dependencies, issues);
  validateTierRequirements(value.tierRequirements, issues);
  validateSignature(value.signature, issues);

  return { valid: issues.length === 0, issues };
}

export function assertPluginManifest(value: unknown): PluginManifest {
  const result = validatePluginManifest(value);
  if (!result.valid) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new TypeError(`Invalid plugin manifest: ${detail}`);
  }

  return value as PluginManifest;
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  issues: ManifestValidationIssue[],
): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    issues.push({ path: `$.${key}`, message: "must be a non-empty string" });
  }
}

function validateCapabilities(value: unknown, issues: ManifestValidationIssue[]): void {
  if (!isJsonObject(value)) {
    issues.push({ path: "$.capabilities", message: "must be an object" });
    return;
  }

  requireStringArray(value, "provides", "$.capabilities.provides", issues);
  requireStringArray(value, "consumes", "$.capabilities.consumes", issues);
}

function validatePermissions(value: unknown, issues: ManifestValidationIssue[]): void {
  if (!isJsonObject(value)) {
    issues.push({ path: "$.permissions", message: "must be an object" });
    return;
  }

  requireStringArray(value, "scopes", "$.permissions.scopes", issues);
  requireStringArray(value, "outbound-network", "$.permissions.outbound-network", issues);
  requireStringArray(value, "filesystem", "$.permissions.filesystem", issues);
  requireStringArray(value, "envVars", "$.permissions.envVars", issues);
}

function validateDependencies(value: unknown, issues: ManifestValidationIssue[]): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path: "$.dependencies", message: "must be an array" });
    return;
  }

  value.forEach((dependency, index) => {
    const path = `$.dependencies[${String(index)}]`;
    if (typeof dependency === "string") {
      if (dependency.length === 0) {
        issues.push({ path, message: "must be a non-empty string" });
      }
      return;
    }

    if (!isJsonObject(dependency)) {
      issues.push({ path, message: "must be a string or dependency object" });
      return;
    }

    if (typeof dependency.id !== "string" || dependency.id.length === 0) {
      issues.push({ path: `${path}.id`, message: "must be a non-empty string" });
    }
    if (dependency.version !== undefined && typeof dependency.version !== "string") {
      issues.push({ path: `${path}.version`, message: "must be a string" });
    }
    if (dependency.optional !== undefined && typeof dependency.optional !== "boolean") {
      issues.push({ path: `${path}.optional`, message: "must be a boolean" });
    }
  });
}

function validateTierRequirements(value: unknown, issues: ManifestValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isJsonObject(value)) {
    issues.push({ path: "$.tierRequirements", message: "must be an object" });
    return;
  }

  if (value.minTier !== undefined && !isSecurityTier(value.minTier)) {
    issues.push({ path: "$.tierRequirements.minTier", message: "must be a security tier" });
  }

  if (value.tierRestrictions === undefined) {
    return;
  }
  if (!isJsonObject(value.tierRestrictions)) {
    issues.push({ path: "$.tierRequirements.tierRestrictions", message: "must be an object" });
    return;
  }
  for (const [tier, restriction] of Object.entries(value.tierRestrictions)) {
    if (!isSecurityTier(tier)) {
      issues.push({
        path: `$.tierRequirements.tierRestrictions.${tier}`,
        message: "must be keyed by a security tier",
      });
    }
    if (restriction !== "prohibited" && !isJsonObject(restriction)) {
      issues.push({
        path: `$.tierRequirements.tierRestrictions.${tier}`,
        message: "must be an object or prohibited",
      });
    }
  }
}

function validateSignature(value: unknown, issues: ManifestValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isJsonObject(value)) {
    issues.push({ path: "$.signature", message: "must be an object" });
    return;
  }
  requireOptionalString(value, "bundleDigest", "$.signature.bundleDigest", issues);
  requireOptionalString(value, "sigstoreBundle", "$.signature.sigstoreBundle", issues);
  requireOptionalString(value, "signerIdentity", "$.signature.signerIdentity", issues);
  requireOptionalString(value, "signedAt", "$.signature.signedAt", issues);

  if (typeof value.bundleDigest === "string" && !isSha256Digest(value.bundleDigest)) {
    issues.push({
      path: "$.signature.bundleDigest",
      message: "must be a sha256:<64 lowercase hex> digest",
    });
  }
  if (
    typeof value.signerIdentity === "string" &&
    !isHttpsUrl(value.signerIdentity) &&
    !isEmailIdentity(value.signerIdentity)
  ) {
    issues.push({
      path: "$.signature.signerIdentity",
      message: "must be an HTTPS URL or email identity",
    });
  }
  if (typeof value.signedAt === "string" && Number.isNaN(Date.parse(value.signedAt))) {
    issues.push({ path: "$.signature.signedAt", message: "must be an ISO date-time string" });
  }
}

function requireStringArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ManifestValidationIssue[],
): void {
  const entry = value[key];
  if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
    issues.push({ path, message: "must be an array of strings" });
  }
}

function requireOptionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ManifestValidationIssue[],
): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    issues.push({ path, message: "must be a string" });
  }
}

function isSecurityTier(value: unknown): value is SecurityTier {
  return (
    value === "personal" || value === "business" || value === "enterprise" || value === "sovereign"
  );
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isEmailIdentity(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
