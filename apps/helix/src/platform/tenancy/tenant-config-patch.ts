import type { JsonObject, JsonValue } from "@helix/sdk-types";

/**
 * Tenant config write semantics, shared by the PostgreSQL store and test doubles.
 *
 * - `featureFlags` is a key-level patch: submitted keys overwrite stored keys,
 *   keys that are not submitted are kept, and a key submitted as JSON `null`
 *   is removed so the plan default applies again.
 * - `quotas` is a key-level patch too, but `null` is a stored value meaning
 *   "unlimited" (it overrides a plan limit), so it is kept rather than removed.
 * - `byoConfig` and `branding` are replaced whole: every caller sends the full
 *   object (the admin UI posts the whole branding form with blank fields
 *   dropped, and BYO storage always sends the complete `storage` block), so
 *   omitting a key is how a field is cleared.
 */
export interface TenantConfigPatchParts {
  /** Keys to write with `||`. */
  readonly merge: JsonObject;
  /** Keys to delete with `-`. */
  readonly remove: readonly string[];
}

export function tenantConfigPatchParts(
  patch: JsonObject,
  options: { readonly nullRemovesKey: boolean },
): TenantConfigPatchParts {
  const merge: Record<string, JsonValue> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && options.nullRemovesKey) {
      remove.push(key);
    } else {
      merge[key] = value;
    }
  }
  return { merge, remove };
}

export const FEATURE_FLAGS_PATCH = { nullRemovesKey: true } as const;
export const QUOTAS_PATCH = { nullRemovesKey: false } as const;

/** In-memory mirror of the SQL `(column || merge) - remove` update. */
export function applyTenantConfigPatch(
  current: JsonObject,
  patch: JsonObject,
  options: { readonly nullRemovesKey: boolean },
): JsonObject {
  const parts = tenantConfigPatchParts(patch, options);
  const removed = new Set(parts.remove);
  return Object.fromEntries(
    Object.entries({ ...current, ...parts.merge }).filter(([key]) => !removed.has(key)),
  );
}
