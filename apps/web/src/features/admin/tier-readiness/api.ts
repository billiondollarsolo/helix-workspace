/* Security tier readiness — platform-config and plugin-catalogue transport.
 *
 * Every fetch validates the payload before it reaches the UI: these endpoints
 * drive destructive controls (tier changes, plugin uninstall), so a malformed
 * response fails loudly instead of rendering as an empty-but-plausible state. */

import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import type {
  PlatformConfigPatch,
  PlatformConfigStatus,
  PluginCatalogItem,
  PluginConfirmation,
  PluginCatalogLifecycleStatus,
  PluginCatalogStatus,
  PluginInstallInput,
  PluginInstallResult,
  PluginLifecycleInput,
  PluginLifecycleResult,
  PluginLifecycleState,
  TierId,
} from "@/features/admin/tier-readiness/types";

export const adminPlatformConfigQueryKey = ["admin", "platform-config"] as const;
export const adminPluginCatalogQueryKey = ["admin", "plugins", "catalog"] as const;

export function adminPlatformConfigQueryOptions() {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminPlatformConfigQueryKey,
    queryFn: fetchPlatformConfigStatus,
    staleTime: 30_000,
  });
}

export function adminPluginCatalogQueryOptions() {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminPluginCatalogQueryKey,
    queryFn: fetchPluginCatalog,
    staleTime: 30_000,
  });
}

interface AdminReadinessRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminPlatformConfigQueryOptions>): Promise<unknown>;
  ensureQueryData(options: ReturnType<typeof adminPluginCatalogQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminReadinessQueries(queryClient: AdminReadinessRouteQueryClient) {
  await Promise.all([
    queryClient.ensureQueryData(adminPlatformConfigQueryOptions()).catch(() => undefined),
    queryClient.ensureQueryData(adminPluginCatalogQueryOptions()).catch(() => undefined),
  ]);
}
/* The five transport calls below all share one shape: read the body, prefer a
   server-supplied `error` string on a non-OK status, then refuse anything the
   type guard does not recognise. `verb` and `missingSubject` exist because the
   emitted strings differ between call sites (`update` rather than `request`;
   "Plugin lifecycle" rather than the action name in the malformed case). */
async function readValidated<T>(
  response: Response,
  guard: (value: unknown) => value is T,
  subject: string,
  verb = "request",
  missingSubject = subject,
): Promise<T> {
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `${subject} ${verb} failed with ${String(response.status)}`);
  }
  if (!guard(output)) {
    throw new Error(`${missingSubject} response was missing required fields.`);
  }
  return output;
}

export async function fetchPlatformConfigStatus(): Promise<PlatformConfigStatus> {
  const response = await authenticatedFetch("/api/admin/platform-config");
  return readValidated(response, isPlatformConfigStatus, "Platform config");
}

export async function updatePlatformTier(tier: TierId): Promise<PlatformConfigStatus> {
  return patchPlatformConfig({ security: { tier } });
}

/** Persist operator AI / mail spam settings via the platform-config admin API. */
export async function updatePlatformAiSettings(
  ai: NonNullable<PlatformConfigPatch["ai"]>,
): Promise<PlatformConfigStatus> {
  return patchPlatformConfig({ ai });
}

export async function patchPlatformConfig(
  payload: PlatformConfigPatch,
): Promise<PlatformConfigStatus> {
  const response = await authenticatedFetch("/api/admin/platform-config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readValidated(response, isPlatformConfigStatus, "Platform config", "update");
}

export async function fetchPluginCatalog(): Promise<PluginCatalogStatus> {
  const response = await authenticatedFetch("/api/tools/plugin.list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return readValidated(response, isPluginCatalogStatus, "Plugin catalog");
}

export async function installPlugin(input: PluginInstallInput): Promise<PluginInstallResult> {
  const response = await authenticatedFetch("/api/tools/plugin.install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readValidated(response, isPluginInstallResult, "Plugin install");
}

/** A lifecycle call plus the confirmation ids the OPERATOR acknowledged.
 *
 *  Not part of `PluginLifecycleInput` on purpose: the field only ever carries
 *  ids that came back from the backend and were then ticked in the UI. */
export interface PluginLifecycleRequest extends PluginLifecycleInput {
  readonly confirmations?: readonly string[];
}

export async function mutatePluginLifecycle(
  input: PluginLifecycleRequest,
): Promise<PluginLifecycleResult> {
  const response = await authenticatedFetch(`/api/tools/plugin.${input.action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginId: input.pluginId,
      /* `plugin.uninstall` answers with the `ConfirmationRequirement`s it wants
         acknowledged and refuses until their ids come back. This client used to
         send `["plugin.uninstall"]` unconditionally — answering the server's
         safety gate on behalf of an operator who was never asked, and defeating
         it from the outside. The ids below are only ever ones the operator
         ticked; an empty list is the honest first request that makes the
         backend state its requirements. */
      ...(input.confirmations === undefined ? {} : { confirmations: input.confirmations }),
    }),
  });
  return readValidated(
    response,
    isPluginLifecycleResult,
    `Plugin ${input.action}`,
    "request",
    "Plugin lifecycle",
  );
}
function isPlatformConfigStatus(value: unknown): value is PlatformConfigStatus {
  return (
    isRecord(value) &&
    isRecord(value.config) &&
    isRecord(value.config.security) &&
    isTierId(value.config.security.tier) &&
    isRecord(value.readiness) &&
    typeof value.readiness.ready === "boolean" &&
    Array.isArray(value.readiness.requirements)
  );
}

function isPluginCatalogStatus(value: unknown): value is PluginCatalogStatus {
  return (
    isRecord(value) && Array.isArray(value.plugins) && value.plugins.every(isPluginCatalogItem)
  );
}

function isPluginCatalogItem(value: unknown): value is PluginCatalogItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.kind === "string" &&
    isRecord(value.capabilities) &&
    isStringArray(value.capabilities.provides) &&
    isStringArray(value.capabilities.consumes) &&
    isRecord(value.permissions) &&
    isStringArray(value.permissions.scopes) &&
    isStringArray(value.permissions["outbound-network"]) &&
    isStringArray(value.permissions.filesystem) &&
    isStringArray(value.permissions.envVars) &&
    (value.lifecycle === undefined ||
      value.lifecycle === null ||
      isPluginCatalogLifecycleStatus(value.lifecycle))
  );
}

function isPluginCatalogLifecycleStatus(value: unknown): value is PluginCatalogLifecycleStatus {
  return (
    isRecord(value) &&
    isPluginLifecycleState(value.state) &&
    (value.installed === undefined || typeof value.installed === "boolean")
  );
}

function isPluginInstallResult(value: unknown): value is PluginInstallResult {
  return (
    isRecord(value) &&
    (value.status === "installed" ||
      value.status === "blocked_confirmation_required" ||
      value.status === "not_found" ||
      value.status === "version_mismatch") &&
    isOptionalConfirmationList(value.confirmations)
  );
}

function isPluginLifecycleResult(value: unknown): value is PluginLifecycleResult {
  return (
    isRecord(value) &&
    (value.status === "enabled" ||
      value.status === "disabled" ||
      value.status === "uninstalled" ||
      value.status === "not_found" ||
      value.status === "not_installed" ||
      value.status === "blocked_confirmation_required") &&
    isOptionalConfirmationList(value.confirmations)
  );
}

/* The confirmation list is what the operator is asked to tick, and its ids are
   what gets sent back to unlock a destructive tool. A half-formed entry would
   render a blank checkbox with no stated consequence, so it fails the response
   instead. */
function isOptionalConfirmationList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isPluginConfirmation));
}

function isPluginConfirmation(value: unknown): value is PluginConfirmation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.category === "string" &&
    typeof value.detail === "string"
  );
}

function isPluginLifecycleState(value: unknown): value is PluginLifecycleState {
  return (
    value === "discovered" ||
    value === "validated" ||
    value === "installed" ||
    value === "migrating" ||
    value === "migrated" ||
    value === "starting" ||
    value === "enabled" ||
    value === "disabled" ||
    value === "degraded" ||
    value === "uninstalling" ||
    value === "uninstalled"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTierId(value: unknown): value is TierId {
  return (
    value === "personal" || value === "business" || value === "enterprise" || value === "sovereign"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
