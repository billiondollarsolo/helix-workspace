import type {
  HelixConfig,
  SecurityTier,
  TierSecurityDefaults,
  ToolConfirmationPolicy,
} from "@helix/sdk-types";

export const tierDefaults: Record<SecurityTier, TierSecurityDefaults> = {
  personal: {
    tier: "personal",
    internalTransit: "plaintext",
    secrets: "env",
    auditHashChain: true,
    auditDestinations: ["postgres"],
    networkEgress: "open",
    toolConfirmation: "destructive",
    pluginSignatureRequired: false,
    localAiOnly: false,
  },
  business: {
    tier: "business",
    internalTransit: "caddy-mtls",
    secrets: "sops",
    auditHashChain: true,
    auditDestinations: ["postgres", "immutable-s3"],
    networkEgress: "recommended-allowlist",
    toolConfirmation: "destructive_and_external",
    pluginSignatureRequired: false,
    localAiOnly: false,
  },
  enterprise: {
    tier: "enterprise",
    internalTransit: "spire-mtls",
    secrets: "vault",
    auditHashChain: true,
    auditDestinations: ["postgres", "immutable-s3", "siem"],
    networkEgress: "required-allowlist",
    toolConfirmation: "all_write",
    pluginSignatureRequired: true,
    localAiOnly: false,
  },
  sovereign: {
    tier: "sovereign",
    internalTransit: "spire-mtls",
    secrets: "vault",
    auditHashChain: true,
    auditDestinations: ["postgres", "worm", "siem"],
    networkEgress: "default-deny",
    toolConfirmation: "all",
    pluginSignatureRequired: true,
    localAiOnly: true,
  },
};

export function resolveTierDefaults(config: HelixConfig): TierSecurityDefaults {
  const base = tierDefaults[config.security.tier];
  return { ...base, ...config.security.overrides, tier: config.security.tier };
}

export function shouldConfirmTool(
  policy: ToolConfirmationPolicy,
  sideEffect: "read" | "write" | "destructive" | "external_communication",
  explicit?: boolean,
): boolean {
  if (explicit === true) {
    return true;
  }
  if (policy === "all") {
    return sideEffect !== "read";
  }
  if (policy === "all_write") {
    return sideEffect === "write" || sideEffect === "destructive" || sideEffect === "external_communication";
  }
  if (policy === "destructive_and_external") {
    return sideEffect === "destructive" || sideEffect === "external_communication";
  }
  return sideEffect === "destructive";
}
