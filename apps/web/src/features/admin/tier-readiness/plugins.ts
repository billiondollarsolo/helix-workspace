/* Security tier readiness — plugin install confirmations and lifecycle rules.
 *
 * Sideloaded and self-hosted plugins carry different risk, so each source has
 * its own set of confirmations the admin must tick before install. */

import { formatToken, formatValue } from "@/features/admin/tier-readiness/format";
import type {
  PluginCatalogItem,
  PluginConfirmation,
  PluginInstallResult,
  PluginLifecycleResult,
  PluginSource,
} from "@/features/admin/tier-readiness/types";

export function pluginConfirmationsForSource(
  plugin: PluginCatalogItem,
  source: PluginSource,
): readonly PluginConfirmation[] {
  if (source === "official") {
    return [];
  }
  const confirmations: PluginConfirmation[] = [
    {
      id: "source.non_official",
      label: "Install from a non-official source",
      category: "source",
      detail: `${plugin.id} will be installed from ${formatToken(source)}.`,
    },
  ];
  appendPluginConfirmations(
    confirmations,
    "permissions.scopes",
    "Scope",
    plugin.permissions.scopes,
  );
  appendPluginConfirmations(
    confirmations,
    "permissions.outbound-network",
    "Outbound network",
    plugin.permissions["outbound-network"],
  );
  appendPluginConfirmations(
    confirmations,
    "permissions.filesystem",
    "Filesystem",
    plugin.permissions.filesystem,
  );
  appendPluginConfirmations(
    confirmations,
    "permissions.envVars",
    "Environment variable",
    plugin.permissions.envVars,
  );
  appendPluginConfirmations(
    confirmations,
    "capabilities.provides",
    "Provided capability",
    plugin.capabilities.provides,
  );
  appendPluginConfirmations(
    confirmations,
    "capabilities.consumes",
    "Consumed capability",
    plugin.capabilities.consumes,
  );
  if (plugin.signature === undefined || plugin.signature === null) {
    confirmations.push({
      id: "signature.missing",
      label: "Unsigned plugin artifact",
      category: "signature",
      detail: "The manifest does not include signed artifact evidence.",
    });
  }
  if (plugin.tierRequirements !== undefined && plugin.tierRequirements !== null) {
    confirmations.push({
      id: "tier.requirements",
      label: "Tier requirements declared",
      category: "tier",
      detail: "Review tier restrictions before installing this plugin.",
    });
  }
  return confirmations;
}

export function appendPluginConfirmations(
  confirmations: PluginConfirmation[],
  field: string,
  label: string,
  values: readonly string[],
): void {
  for (const value of values) {
    confirmations.push({
      id: `${field}.${value}`,
      label,
      category: field,
      detail: value,
    });
  }
}

export function pluginInstallStatusMessage(result: PluginInstallResult): string {
  if (result.status === "installed") {
    return `Install validated for ${result.plugin?.name ?? "plugin"}.`;
  }
  if (result.status === "blocked_confirmation_required") {
    return `Confirm ${String(result.confirmations?.length ?? 0)} remaining plugin requirements.`;
  }
  if (result.status === "version_mismatch") {
    return "Requested plugin version is not available.";
  }
  return result.message ?? "Plugin was not found.";
}

export function pluginLifecycleStatusMessage(result: PluginLifecycleResult): string {
  if (
    result.status === "enabled" ||
    result.status === "disabled" ||
    result.status === "uninstalled"
  ) {
    return `${formatValue(result.status)} ${result.plugin?.name ?? "plugin"}.`;
  }
  if (result.status === "blocked_confirmation_required") {
    return `Confirm ${String(result.confirmations?.length ?? 0)} plugin lifecycle requirements.`;
  }
  return result.message ?? "Plugin lifecycle request did not complete.";
}

export function pluginLifecycleLabel(plugin: PluginCatalogItem): string {
  if (plugin.install?.optimisticStatus === "installing") {
    return "Installing";
  }
  const lifecycle = plugin.lifecycle;
  if (lifecycle?.installed !== true) {
    return plugin.install?.optimisticStatus === "installed" ? "Installed" : "Not installed";
  }
  return formatValue(lifecycle.state);
}

export function canEnablePlugin(plugin: PluginCatalogItem): boolean {
  return (
    plugin.lifecycle?.installed === true &&
    (plugin.lifecycle.state === "installed" ||
      plugin.lifecycle.state === "migrated" ||
      plugin.lifecycle.state === "disabled" ||
      plugin.lifecycle.state === "degraded")
  );
}

export function canDisablePlugin(plugin: PluginCatalogItem): boolean {
  return plugin.lifecycle?.installed === true && plugin.lifecycle.state === "enabled";
}

export function canUninstallPlugin(plugin: PluginCatalogItem): boolean {
  return (
    plugin.lifecycle?.installed === true &&
    plugin.lifecycle.state !== "uninstalled" &&
    plugin.lifecycle.state !== "uninstalling"
  );
}
