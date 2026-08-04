import type {
  HelixConfig,
  SecurityTier,
  TierOverrides,
  TierSecurityDefaults,
  ToolSideEffect,
} from "@helix/sdk";

export const tierDefaults: Record<SecurityTier, TierSecurityDefaults> = {
  personal: {
    tier: "personal",
    internalTransit: "plaintext",
    secrets: "env",
    auditHashChain: false,
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
  const overrides = config.security.overrides ?? {};

  return {
    ...base,
    ...definedOverrides(overrides),
    tier: config.security.tier,
  };
}

export function confirmationRequiredForSideEffect(
  sideEffect: ToolSideEffect,
  defaults: TierSecurityDefaults,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) {
    return explicit;
  }

  switch (defaults.toolConfirmation) {
    case "destructive":
      return sideEffect === "destructive";
    case "destructive_and_external":
      return sideEffect === "destructive" || sideEffect === "external_communication";
    case "all_write":
      return sideEffect !== "read";
    case "all":
      return true;
  }
}

function definedOverrides(overrides: TierOverrides): Partial<TierSecurityDefaults> {
  // Explicit `undefined` override values must not shadow the tier default when
  // spread over it, so they are dropped rather than passed through.
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
}
