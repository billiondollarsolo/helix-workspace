import {
  AlertTriangle,
  ArchiveRestore,
  BadgeDollarSign,
  CheckCircle2,
  CircleDashed,
  Cloud,
  Database,
  KeyRound,
  LockKeyhole,
  RadioTower,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

export type TierId = "personal" | "business" | "enterprise" | "sovereign";
type CheckStatus = "ready" | "warning" | "blocked" | "not-required";
type ServiceStatus = "online" | "configured" | "pending" | "missing";
type BackendReadinessStatus = "ready" | "missing" | "not_required" | "unknown" | "degraded";
type PluginLifecycleState =
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

export interface PlatformConfigPatch {
  readonly security: {
    readonly tier: TierId;
  };
}

interface TierDefinition {
  readonly id: TierId;
  readonly shortName: string;
  readonly title: string;
  readonly target: string;
  readonly serviceSummary: string;
  readonly requiredServiceIds: readonly string[];
}

interface ReadinessCheck {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly statusByTier: Readonly<Record<TierId, CheckStatus>>;
}

interface RequiredService {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly status: ServiceStatus;
}

interface RenderedService extends RequiredService {
  readonly backendStatus?: BackendReadinessStatus;
}

interface ControlRow {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly valuesByTier: Readonly<Record<TierId, string>>;
  readonly currentValue: string;
}

interface RenderedControlRow extends ControlRow {
  readonly tierDefault: string;
  readonly isOverridden: boolean;
}

interface PlatformConfigStatus {
  readonly config: {
    readonly security: {
      readonly tier: TierId;
    };
    readonly ai?: AIConfigStatus;
  };
  readonly readiness: {
    readonly ready: boolean;
    readonly requirements: readonly BackendRequirement[];
  };
}

interface AIConfigStatus {
  readonly costLimits?: {
    readonly perUserPerDayUSD?: number;
    readonly perOrgPerDayUSD?: number;
    readonly perAgentPerDayUSD?: number;
  };
  readonly audit?: {
    readonly logRequests?: "off" | "metadata-only" | "full";
    readonly retainDays?: number;
  };
  readonly privacy?: {
    readonly redactPIIBeforeSend?: boolean;
    readonly classificationGating?: boolean;
    readonly blockExternalForClassifications?: readonly string[];
  };
}

type PluginSource = "official" | "sideload" | "self-hosted";

interface PluginConfirmation {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly detail: string;
}

interface PluginCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | null;
  readonly kind: string;
  readonly capabilities: {
    readonly provides: readonly string[];
    readonly consumes: readonly string[];
  };
  readonly permissions: {
    readonly scopes: readonly string[];
    readonly "outbound-network": readonly string[];
    readonly filesystem: readonly string[];
    readonly envVars: readonly string[];
  };
  readonly lifecycle?: PluginCatalogLifecycleStatus | null;
  readonly install?: PluginCatalogInstallStatus | null;
  readonly signature?: Record<string, unknown> | null;
  readonly tierRequirements?: Record<string, unknown> | null;
}

interface PluginCatalogLifecycleStatus {
  readonly state: PluginLifecycleState;
  readonly installed?: boolean;
  readonly updatedAt?: string;
  readonly source?: PluginSource;
}

interface PluginCatalogInstallStatus {
  readonly confirmationRequired?: boolean;
  readonly confirmations?: readonly PluginConfirmation[];
  readonly optimisticStatus?: "installing" | "installed";
  readonly source?: PluginSource;
}

interface PluginCatalogStatus {
  readonly plugins: readonly PluginCatalogItem[];
}

interface PluginInstallInput {
  readonly pluginId: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly confirmations: readonly string[];
}

interface PluginInstallResult {
  readonly status: "installed" | "blocked_confirmation_required" | "not_found" | "version_mismatch";
  readonly plugin?: PluginCatalogItem;
  readonly lifecycle?: PluginCatalogLifecycleStatus;
  readonly confirmations?: readonly PluginConfirmation[];
  readonly source?: PluginSource;
  readonly message?: string;
}

type PluginLifecycleAction = "enable" | "disable" | "uninstall";

interface PluginLifecycleInput {
  readonly action: PluginLifecycleAction;
  readonly pluginId: string;
}

interface PluginLifecycleResult {
  readonly status:
    | "enabled"
    | "disabled"
    | "uninstalled"
    | "not_found"
    | "not_installed"
    | "blocked_confirmation_required";
  readonly plugin?: PluginCatalogItem;
  readonly lifecycle?: PluginCatalogLifecycleStatus;
  readonly confirmations?: readonly PluginConfirmation[];
  readonly message?: string;
}

interface BackendRequirement {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: BackendReadinessStatus;
  readonly expected: Record<string, unknown>;
  readonly observed: Record<string, unknown>;
  readonly missing?: readonly string[];
}

interface RequirementField {
  readonly label: string;
  readonly value: string;
}

interface RenderedReadinessCheck extends ReadinessCheck {
  readonly status: CheckStatus;
  readonly expectedFields?: readonly RequirementField[];
  readonly observedFields?: readonly RequirementField[];
  readonly missing?: readonly string[];
}

interface AICostAuditRow {
  readonly id: string;
  readonly label: string;
  readonly tierDefault: string;
  readonly configured: string;
  readonly evidence: string;
}

const tiers: readonly TierDefinition[] = [
  {
    id: "personal",
    shortName: "Tier 1",
    title: "Personal",
    target: "Single VPS or small team",
    serviceSummary: "7 core services",
    requiredServiceIds: ["postgres", "rustfs", "nats", "meilisearch", "cerbos", "redis", "caddy"],
  },
  {
    id: "business",
    shortName: "Tier 2",
    title: "Business",
    target: "Professional single-region deployment",
    serviceSummary: "Tier 1 plus secrets and audit shipping",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "secrets",
      "audit-shipper",
    ],
  },
  {
    id: "enterprise",
    shortName: "Tier 3",
    title: "Enterprise",
    target: "Regulated and high-availability deployments",
    serviceSummary: "Vault, SPIRE, CloudNativePG, and SIEM bridge",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "vault",
      "audit-shipper",
      "spire",
      "cloudnativepg",
      "siem",
    ],
  },
  {
    id: "sovereign",
    shortName: "Tier 4",
    title: "Sovereign",
    target: "Air-gapped, FIPS, ATO-track environments",
    serviceSummary: "Full Tier 3 plus FIPS, STIG, HSM, and air-gap tooling",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "vault",
      "audit-shipper",
      "spire",
      "cloudnativepg",
      "siem",
      "fips",
      "stig",
      "airgap",
      "hsm",
    ],
  },
];

const requiredServices: readonly RequiredService[] = [
  {
    id: "postgres",
    name: "Postgres",
    description: "Platform metadata, auth, documents, audit chain",
    icon: Database,
    status: "online",
  },
  {
    id: "rustfs",
    name: "RustFS / S3",
    description: "Object storage with versioning and backup target hooks",
    icon: Cloud,
    status: "online",
  },
  {
    id: "nats",
    name: "NATS JetStream",
    description: "Durable events, plugin broadcasts, activity fanout",
    icon: RadioTower,
    status: "online",
  },
  {
    id: "meilisearch",
    name: "Meilisearch",
    description: "Derived unified search index",
    icon: ServerCog,
    status: "online",
  },
  {
    id: "cerbos",
    name: "Cerbos",
    description: "Policy decision point for platform permissions",
    icon: ShieldCheck,
    status: "online",
  },
  {
    id: "redis",
    name: "Redis",
    description: "Sessions, rate limits, and ephemeral presence",
    icon: Database,
    status: "online",
  },
  {
    id: "caddy",
    name: "Caddy edge",
    description: "TLS 1.3 edge, reverse proxy, readiness handoff",
    icon: ShieldCheck,
    status: "configured",
  },
  {
    id: "secrets",
    name: "SOPS or Vault",
    description: "Tier 2 secrets backend selection",
    icon: KeyRound,
    status: "configured",
  },
  {
    id: "audit-shipper",
    name: "Audit shipper",
    description: "Immutable S3 Object Lock delivery",
    icon: ArchiveRestore,
    status: "configured",
  },
  {
    id: "vault",
    name: "HashiCorp Vault",
    description: "Mandatory Tier 3+ secrets backend and rotation source",
    icon: KeyRound,
    status: "pending",
  },
  {
    id: "spire",
    name: "SPIRE",
    description: "SPIFFE workload identity and internal mTLS",
    icon: ShieldQuestion,
    status: "pending",
  },
  {
    id: "cloudnativepg",
    name: "CloudNativePG",
    description: "HA Postgres operator and PITR workflow",
    icon: Database,
    status: "missing",
  },
  {
    id: "siem",
    name: "SIEM bridge",
    description: "CEF/LEEF or syslog delivery for immutable audit",
    icon: RadioTower,
    status: "missing",
  },
  {
    id: "fips",
    name: "FIPS adapters",
    description: "Validated crypto module integration points",
    icon: LockKeyhole,
    status: "missing",
  },
  {
    id: "stig",
    name: "STIG images",
    description: "Hardened image family and checklist evidence",
    icon: ServerCog,
    status: "missing",
  },
  {
    id: "airgap",
    name: "Air-gap tooling",
    description: "Offline plugin bundle and registry import workflow",
    icon: ArchiveRestore,
    status: "missing",
  },
  {
    id: "hsm",
    name: "HSM / KMS",
    description: "HSM-backed keys for backups and protected stores",
    icon: LockKeyhole,
    status: "missing",
  },
];

const readinessChecks: readonly ReadinessCheck[] = [
  {
    id: "backup-encryption",
    title: "Backup encryption",
    detail:
      "Business upgrades require a successful encrypted backup before the tier engine can apply the change.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "blocked",
    },
  },
  {
    id: "audit-destinations",
    title: "Audit destinations",
    detail:
      "Postgres audit is local; higher tiers require immutable object storage, SIEM, or WORM destinations.",
    statusByTier: {
      personal: "ready",
      business: "ready",
      enterprise: "blocked",
      sovereign: "blocked",
    },
  },
  {
    id: "mfa-policy",
    title: "MFA policy",
    detail:
      "Admin MFA is set for Business; Enterprise and Sovereign need org-wide enforcement or CAC/PIV.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "blocked",
    },
  },
  {
    id: "secrets-backend",
    title: "Secrets backend",
    detail: "SOPS satisfies Tier 2; Tier 3+ requires Vault health and rotation evidence.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "warning",
    },
  },
  {
    id: "workload-identity",
    title: "Workload identity",
    detail: "Tier 3+ requires SPIRE/SPIFFE internal identity and mTLS certificates.",
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "warning",
      sovereign: "warning",
    },
  },
  {
    id: "ha-postgres",
    title: "HA Postgres",
    detail: "Tier 3+ requires CloudNativePG HA Postgres evidence before readiness is complete.",
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "blocked",
      sovereign: "blocked",
    },
  },
];

const controls: readonly ControlRow[] = [
  {
    id: "backup",
    label: "Backup encryption",
    icon: ArchiveRestore,
    currentValue: "age encrypted backup to S3 with versioning",
    valuesByTier: {
      personal: "none or optional gpg",
      business: "age encryption before upload",
      enterprise: "KMS-backed envelope encryption",
      sovereign: "HSM-backed encryption to WORM destination",
    },
  },
  {
    id: "audit",
    label: "Audit destinations",
    icon: RadioTower,
    currentValue: "Postgres plus immutable S3",
    valuesByTier: {
      personal: "Postgres only",
      business: "immutable S3 Object Lock",
      enterprise: "immutable S3 plus SIEM",
      sovereign: "WORM storage plus SIEM in CEF/LEEF",
    },
  },
  {
    id: "mfa",
    label: "MFA",
    icon: ShieldCheck,
    currentValue: "admins required, passkeys enabled",
    valuesByTier: {
      personal: "optional TOTP",
      business: "admins required",
      enterprise: "org-wide required, SAML/OIDC plugin",
      sovereign: "CAC/PIV smartcard",
    },
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyRound,
    currentValue: "SOPS with age keys",
    valuesByTier: {
      personal: "environment variables",
      business: "SOPS or Vault",
      enterprise: "Vault mandatory, 90-day rotation",
      sovereign: "Vault plus HSM-backed keys",
    },
  },
  {
    id: "ha",
    label: "Availability",
    icon: Database,
    currentValue: "single Postgres instance",
    valuesByTier: {
      personal: "single instance",
      business: "single region",
      enterprise: "CloudNativePG, 3-replica NATS",
      sovereign: "Tier 3 HA with air-gap evidence",
    },
  },
];

const aiCostDefaultsByTier: Readonly<Record<TierId, AIConfigStatus["costLimits"]>> = {
  personal: {},
  business: {
    perUserPerDayUSD: 10,
    perOrgPerDayUSD: 500,
    perAgentPerDayUSD: 10,
  },
  enterprise: {
    perUserPerDayUSD: 50,
    perAgentPerDayUSD: 50,
  },
  sovereign: {
    perUserPerDayUSD: 0,
    perOrgPerDayUSD: 0,
    perAgentPerDayUSD: 0,
  },
};

const statusText: Readonly<Record<CheckStatus, string>> = {
  ready: "Ready",
  warning: "Needs evidence",
  blocked: "Blocked",
  "not-required": "Not required",
};

const serviceStatusText: Readonly<Record<ServiceStatus, string>> = {
  online: "Online",
  configured: "Configured",
  pending: "Pending",
  missing: "Missing",
};

const serviceById = new Map(requiredServices.map((service) => [service.id, service]));
const readinessRequirementKeyByCheckId: Readonly<
  Partial<Record<string, BackendRequirement["key"]>>
> = {
  "backup-encryption": "encryptedBackups",
  "audit-destinations": "auditDestinations",
  "mfa-policy": "mfa",
  "secrets-backend": "vault",
  "workload-identity": "spire",
  "ha-postgres": "cloudNativePg",
};
const serviceRequirementKeyById: Readonly<Partial<Record<string, BackendRequirement["key"]>>> = {
  vault: "vault",
  spire: "spire",
  siem: "siem",
  cloudnativepg: "cloudNativePg",
};

export const adminPlatformConfigQueryKey = ["admin", "platform-config"] as const;
export const adminPluginCatalogQueryKey = ["admin", "plugins", "catalog"] as const;

export function adminPlatformConfigQueryOptions() {
  return queryOptions({
    queryKey: adminPlatformConfigQueryKey,
    queryFn: fetchPlatformConfigStatus,
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export function adminPluginCatalogQueryOptions() {
  return queryOptions({
    queryKey: adminPluginCatalogQueryKey,
    queryFn: fetchPluginCatalog,
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
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

export function SecurityTierReadiness() {
  const [selectedTierId, setSelectedTierId] = useState<TierId>("business");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginSource, setPluginSource] = useState<PluginSource>("official");
  const [confirmedPluginRequirements, setConfirmedPluginRequirements] = useState<readonly string[]>(
    [],
  );
  const [pluginInstallStatus, setPluginInstallStatus] = useState<PluginInstallResult | null>(null);
  const [pluginLifecycleStatus, setPluginLifecycleStatus] = useState<PluginLifecycleResult | null>(
    null,
  );
  const [controlOverrides, setControlOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(controls.map((control) => [control.id, control.currentValue])),
  );
  const queryClient = useQueryClient();
  const platformConfigQuery = useQuery(adminPlatformConfigQueryOptions());
  const pluginCatalogQuery = useQuery(adminPluginCatalogQueryOptions());
  const tierMutation = useMutation({
    mutationFn: updatePlatformTier,
    onMutate: async (tier) => {
      await queryClient.cancelQueries({ queryKey: adminPlatformConfigQueryKey });
      const previousPlatformConfig = queryClient.getQueryData<PlatformConfigStatus>(
        adminPlatformConfigQueryKey,
      );

      queryClient.setQueryData<PlatformConfigStatus | undefined>(
        adminPlatformConfigQueryKey,
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                config: {
                  ...current.config,
                  security: {
                    ...current.config.security,
                    tier,
                  },
                },
              },
      );

      return { previousPlatformConfig };
    },
    onError: (_error, _tier, context) => {
      if (context?.previousPlatformConfig !== undefined) {
        queryClient.setQueryData(adminPlatformConfigQueryKey, context.previousPlatformConfig);
      }
    },
    onSuccess: (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      setSelectedTierId(status.config.security.tier);
    },
  });
  const pluginInstallMutation = useMutation({
    mutationFn: installPlugin,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: adminPluginCatalogQueryKey });
      const previousPluginCatalog = queryClient.getQueryData<PluginCatalogStatus>(
        adminPluginCatalogQueryKey,
      );

      queryClient.setQueryData<PluginCatalogStatus | undefined>(
        adminPluginCatalogQueryKey,
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                plugins: current.plugins.map((plugin) =>
                  plugin.id === input.pluginId && plugin.version === input.version
                    ? {
                        ...plugin,
                        install: {
                          ...(plugin.install ?? {}),
                          optimisticStatus: "installing",
                          source: input.source,
                        },
                      }
                    : plugin,
                ),
              },
      );

      return { previousPluginCatalog };
    },
    onError: (_error, _input, context) => {
      if (context?.previousPluginCatalog !== undefined) {
        queryClient.setQueryData(adminPluginCatalogQueryKey, context.previousPluginCatalog);
      }
    },
    onSuccess: (result) => {
      setPluginInstallStatus(result);
      if (result.status === "installed" && result.plugin !== undefined) {
        queryClient.setQueryData<PluginCatalogStatus | undefined>(
          adminPluginCatalogQueryKey,
          (current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  plugins: current.plugins.map((plugin) =>
                    plugin.id === result.plugin?.id
                      ? {
                          ...plugin,
                          ...result.plugin,
                          install: {
                            ...(plugin.install ?? {}),
                            optimisticStatus: "installed",
                            source: result.source,
                          },
                        }
                      : plugin,
                  ),
                },
        );
      }
      void queryClient.invalidateQueries({ queryKey: adminPluginCatalogQueryKey });
    },
  });
  const pluginLifecycleMutation = useMutation({
    mutationFn: mutatePluginLifecycle,
    onMutate: () => undefined,
    onError: () => {
      setPluginLifecycleStatus(null);
    },
    onSuccess: (result) => {
      setPluginLifecycleStatus(result);
      if (result.plugin !== undefined && result.lifecycle !== undefined) {
        queryClient.setQueryData<PluginCatalogStatus | undefined>(
          adminPluginCatalogQueryKey,
          (current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  plugins: current.plugins.map((plugin) =>
                    plugin.id === result.plugin?.id
                      ? {
                          ...plugin,
                          ...result.plugin,
                          lifecycle: result.lifecycle,
                        }
                      : plugin,
                  ),
                },
        );
      }
      void queryClient.invalidateQueries({ queryKey: adminPluginCatalogQueryKey });
    },
  });

  useEffect(() => {
    const tier = platformConfigQuery.data?.config.security.tier;
    if (tier !== undefined) {
      setSelectedTierId(tier);
    }
  }, [platformConfigQuery.data?.config.security.tier]);

  const pluginCatalog = pluginCatalogQuery.data?.plugins ?? [];
  const selectedPlugin = useMemo(
    () => pluginCatalog.find((plugin) => plugin.id === selectedPluginId) ?? pluginCatalog[0],
    [pluginCatalog, selectedPluginId],
  );
  const pluginConfirmations = useMemo(
    () =>
      selectedPlugin === undefined
        ? []
        : pluginConfirmationsForSource(selectedPlugin, pluginSource),
    [pluginSource, selectedPlugin],
  );
  const confirmedPluginIds = useMemo(
    () => new Set(confirmedPluginRequirements),
    [confirmedPluginRequirements],
  );
  const allPluginConfirmationsAccepted = pluginConfirmations.every((confirmation) =>
    confirmedPluginIds.has(confirmation.id),
  );

  useEffect(() => {
    if (selectedPluginId !== null || pluginCatalog.length === 0) {
      return;
    }
    setSelectedPluginId(pluginCatalog[0]?.id ?? null);
  }, [pluginCatalog, selectedPluginId]);

  useEffect(() => {
    setConfirmedPluginRequirements([]);
    setPluginInstallStatus(null);
  }, [pluginSource, selectedPlugin?.id]);

  const selectedTier = tiers.find((tier) => tier.id === selectedTierId) ?? tiers[1];
  if (selectedTier === undefined) {
    throw new Error(`Unknown security tier: ${selectedTierId}`);
  }

  const backendStatus = platformConfigQuery.data;
  const platformConfigError =
    platformConfigQuery.error instanceof Error ? platformConfigQuery.error.message : null;
  const backendRequirements =
    backendStatus?.config.security.tier === selectedTierId
      ? backendStatus.readiness.requirements
      : undefined;
  const requiredServiceList = useMemo(() => {
    if (platformConfigQuery.isError) {
      return [];
    }
    return selectedTier.requiredServiceIds.flatMap((serviceId) => {
      const service = serviceById.get(serviceId);
      if (service === undefined) {
        return [];
      }
      return [
        serviceFromBackendRequirement(
          service,
          backendRequirements?.find(
            (requirement) => requirement.key === serviceRequirementKeyById[service.id],
          ),
        ),
      ];
    });
  }, [backendRequirements, platformConfigQuery.isError, selectedTier]);
  const selectedChecks = useMemo(() => {
    if (platformConfigQuery.isError) {
      return [];
    }
    return readinessChecksForTier(selectedTierId, backendRequirements);
  }, [backendRequirements, platformConfigQuery.isError, selectedTierId]);
  const actionableChecks = selectedChecks.filter((check) => check.status !== "not-required");
  const readyChecks = actionableChecks.filter((check) => check.status === "ready").length;
  const readinessPercent =
    actionableChecks.length === 0 ? 100 : Math.round((readyChecks / actionableChecks.length) * 100);
  const blockingChecks = selectedChecks.filter((check) => check.status === "blocked").length;
  const selectedTierTitle = titleForTier(selectedTierId);
  const currentTierTitle =
    backendStatus === undefined ? "Unavailable" : titleForTier(backendStatus.config.security.tier);
  const resetControlOverride = useCallback(
    (controlId: string) => {
      const control = controls.find((candidate) => candidate.id === controlId);
      if (control === undefined) {
        return;
      }
      setControlOverrides((current) => ({
        ...current,
        [controlId]: control.valuesByTier[selectedTierId],
      }));
    },
    [selectedTierId],
  );
  const controlRows = useMemo<RenderedControlRow[]>(
    () =>
      controls.map((control) => {
        const tierDefault = control.valuesByTier[selectedTierId];
        const currentValue = controlOverrides[control.id] ?? control.currentValue;
        return {
          ...control,
          currentValue,
          tierDefault,
          isOverridden: currentValue !== tierDefault,
        };
      }),
    [controlOverrides, selectedTierId],
  );
  const controlColumns = useMemo<ColumnDef<RenderedControlRow>[]>(
    () => [
      {
        id: "control",
        header: "Control",
        cell: ({ row }) => {
          const Icon = row.original.icon;
          return (
            <>
              <Icon aria-hidden="true" size={18} />
              {row.original.label}
            </>
          );
        },
      },
      {
        accessorKey: "tierDefault",
        header: "Tier default",
        cell: ({ row }) => row.original.tierDefault,
      },
      {
        accessorKey: "currentValue",
        header: "Current override",
        cell: ({ row }) => row.original.currentValue,
      },
      {
        id: "reset",
        header: "Reset",
        cell: ({ row }) => (
          <button
            aria-label={`Reset ${row.original.label} to tier default`}
            className="helix-button helix-button-secondary"
            disabled={!row.original.isOverridden}
            onClick={() => resetControlOverride(row.original.id)}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={14} />
            Reset
          </button>
        ),
      },
    ],
    [resetControlOverride],
  );
  const controlTable = useReactTable({
    columns: controlColumns,
    data: controlRows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });
  const pluginCatalogColumns = useMemo<ColumnDef<PluginCatalogItem>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Plugin",
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <span>{row.original.id}</span>
          </>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => formatValue(row.original.kind),
      },
      {
        accessorKey: "version",
        header: "Version",
      },
      {
        id: "permissions",
        header: "Permissions",
        cell: ({ row }) => row.original.permissions.scopes.length,
      },
      {
        id: "lifecycle",
        header: "Lifecycle",
        cell: ({ row }) => pluginLifecycleLabel(row.original),
      },
      {
        id: "review",
        header: "Action",
        cell: ({ row }) => {
          const plugin = row.original;
          const pendingPluginId = pluginLifecycleMutation.variables?.pluginId;
          const isPending = pluginLifecycleMutation.isPending && pendingPluginId === plugin.id;
          return (
            <div className="flex flex-wrap gap-2">
              <button
                className="helix-button helix-button-secondary"
                disabled={plugin.id === selectedPlugin?.id}
                onClick={() => setSelectedPluginId(plugin.id)}
                type="button"
              >
                {plugin.id === selectedPlugin?.id ? "Selected" : "Review"}
              </button>
              {canEnablePlugin(plugin) ? (
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() =>
                    pluginLifecycleMutation.mutate({ action: "enable", pluginId: plugin.id })
                  }
                  type="button"
                >
                  Enable
                </button>
              ) : null}
              {canDisablePlugin(plugin) ? (
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() =>
                    pluginLifecycleMutation.mutate({ action: "disable", pluginId: plugin.id })
                  }
                  type="button"
                >
                  Disable
                </button>
              ) : null}
              {canUninstallPlugin(plugin) ? (
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() =>
                    pluginLifecycleMutation.mutate({ action: "uninstall", pluginId: plugin.id })
                  }
                  type="button"
                >
                  Uninstall
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [pluginLifecycleMutation, selectedPlugin?.id],
  );
  const pluginCatalogTableData = useMemo<PluginCatalogItem[]>(
    () => [...pluginCatalog],
    [pluginCatalog],
  );
  const pluginCatalogTable = useReactTable({
    columns: pluginCatalogColumns,
    data: pluginCatalogTableData,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });
  const aiCostAuditRows = useMemo(
    () => aiCostAuditRowsForTier(selectedTierId, backendStatus?.config.ai),
    [backendStatus?.config.ai, selectedTierId],
  );

  return (
    <section className="admin-tier-page" aria-labelledby="admin-tier-title" role="main">
      <header className="admin-tier-header">
        <div>
          <p className="admin-tier-kicker">Admin</p>
          <h1 id="admin-tier-title">Security tier readiness</h1>
          <p>
            Select a target tier, review readiness gates, and see which services the tier engine
            expects before applying the configuration.
          </p>
          <p className="admin-tier-live-status">
            {platformConfigQuery.isPending
              ? "Loading platform config"
              : backendStatus !== undefined
                ? "Live platform config connected"
                : "Admin config API unavailable or unauthorized"}
          </p>
        </div>
        <div className="admin-tier-score" aria-label={`${readinessPercent}% readiness`}>
          <strong>{readinessPercent}%</strong>
          <span>{blockingChecks} blocking</span>
        </div>
      </header>

      <div className="admin-tier-selector" aria-label="Security tier selector" role="group">
        {tiers.map((tier) => (
          <button
            className={tier.id === selectedTierId ? "selected" : ""}
            key={tier.id}
            onClick={() => setSelectedTierId(tier.id)}
            disabled={tierMutation.isPending}
            type="button"
          >
            <span>{tier.shortName}</span>
            <strong>{tier.title}</strong>
            <small>{tier.target}</small>
          </button>
        ))}
      </div>

      <div className="admin-tier-grid">
        <section
          className="admin-tier-panel admin-tier-readiness"
          aria-labelledby="readiness-title"
        >
          <div className="admin-tier-panel-header">
            <div>
              <p className="admin-tier-kicker">Target</p>
              <h2 id="readiness-title">
                {selectedTier.shortName}: {selectedTier.title}
              </h2>
              <p>{selectedTier.serviceSummary}</p>
            </div>
            <div className="admin-tier-progress" aria-hidden="true">
              <span style={{ width: `${readinessPercent}%` }} />
            </div>
          </div>

          <div className="admin-check-list">
            {selectedChecks.length === 0 ? (
              <p>
                Readiness gates are unavailable until the admin config API returns a valid response.
              </p>
            ) : (
              selectedChecks.map((check) => (
                <article className="admin-check-row" data-status={check.status} key={check.id}>
                  <StatusIcon status={check.status} />
                  <div>
                    <h3>{check.title}</h3>
                    {check.detail.length > 0 ? <p>{check.detail}</p> : null}
                    <RequirementFacts check={check} />
                  </div>
                  <span>{statusText[check.status]}</span>
                </article>
              ))
            )}
          </div>
        </section>

        <aside className="admin-tier-panel admin-tier-summary" aria-labelledby="summary-title">
          <p className="admin-tier-kicker">Current config</p>
          <h2 id="summary-title">{currentTierTitle} platform state</h2>
          <dl>
            <div>
              <dt>Selected tier</dt>
              <dd>{selectedTierTitle}</dd>
            </div>
            <div>
              <dt>Live tier</dt>
              <dd>{currentTierTitle}</dd>
            </div>
            <div>
              <dt>Readiness</dt>
              <dd>
                {platformConfigQuery.isPending
                  ? "Loading"
                  : backendStatus === undefined
                    ? "Backend unavailable"
                    : backendStatus.readiness.ready
                      ? "Ready"
                      : `${blockingChecks} blocking`}
              </dd>
            </div>
            <div>
              <dt>Backend requirements</dt>
              <dd>
                {platformConfigQuery.isPending
                  ? "Loading"
                  : backendStatus === undefined
                    ? "Unavailable"
                    : backendRequirements === undefined
                      ? "Select live tier for backend gates"
                      : `${backendRequirements.length} live gates`}
              </dd>
            </div>
          </dl>
          <button className="helix-button helix-button-secondary" type="button">
            {tierMutation.isPending ? (
              <CircleDashed aria-hidden="true" size={16} />
            ) : (
              <ShieldCheck aria-hidden="true" size={16} />
            )}
            {platformConfigQuery.isPending
              ? "Loading config API"
              : backendStatus !== undefined
                ? "Config API connected"
                : "Config API unavailable"}
          </button>
          <button
            className="helix-button"
            disabled={tierMutation.isPending || backendStatus === undefined}
            onClick={() => tierMutation.mutate(selectedTierId)}
            type="button"
          >
            Apply tier draft
          </button>
          {tierMutation.isError ? <p role="alert">Could not apply the tier draft.</p> : null}
          {platformConfigQuery.isError ? (
            <p role="alert">
              {platformConfigError ??
                "Admin config API is unavailable or missing admin config scope."}
            </p>
          ) : null}
        </aside>
      </div>

      <section className="admin-tier-panel" aria-labelledby="services-title">
        <div className="admin-tier-panel-header">
          <div>
            <p className="admin-tier-kicker">Required services</p>
            <h2 id="services-title">Runtime dependencies for {selectedTier.title}</h2>
            <p>
              {platformConfigQuery.isError
                ? "Connect the admin config API to see backend-managed service health."
                : backendRequirements === undefined
                  ? "Select the live tier to see backend-managed service gates."
                  : "Live readiness gates are reflected for backend-managed services."}
            </p>
          </div>
        </div>
        <div className="admin-service-grid">
          {requiredServiceList.length === 0 ? (
            <p>
              Service gates are unavailable until the admin config API returns a valid response.
            </p>
          ) : (
            requiredServiceList.map((service) => (
              <article className="admin-service-card" data-status={service.status} key={service.id}>
                <service.icon aria-hidden="true" size={20} />
                <div>
                  <h3>{service.name}</h3>
                  <p>{service.description}</p>
                </div>
                <span>
                  {service.backendStatus === undefined
                    ? serviceStatusText[service.status]
                    : backendStatusText(service.backendStatus)}
                </span>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="admin-tier-panel" aria-labelledby="controls-title">
        <div className="admin-tier-panel-header">
          <div>
            <p className="admin-tier-kicker">Per-layer controls</p>
            <h2 id="controls-title">Defaults and current overrides</h2>
            <p>
              Each row mirrors a PRD override surface that will become editable through config
              schema forms.
            </p>
          </div>
        </div>
        <Table aria-label="Security controls" className="admin-tier-table" role="table">
          <TableHeader>
            {controlTable.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} role="row">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} role="columnheader">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {controlTable.getRowModel().rows.map((row) => (
              <TableRow key={row.id} role="row">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} role="cell">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="admin-tier-panel" aria-labelledby="ai-cost-audit-title">
        <div className="admin-tier-panel-header">
          <div>
            <p className="admin-tier-kicker">AI governance</p>
            <h2 id="ai-cost-audit-title">Cost limits and audit evidence</h2>
            <p>
              Daily AI spend controls, request audit posture, and classification gating are shown
              beside tier defaults for dashboard review.
            </p>
          </div>
        </div>
        <div className="admin-ai-cost-grid">
          {aiCostAuditRows.map((row) => (
            <article className="admin-ai-cost-card" key={row.id}>
              <BadgeDollarSign aria-hidden="true" size={18} />
              <div>
                <h3>{row.label}</h3>
                <dl>
                  <div>
                    <dt>Tier default</dt>
                    <dd>{row.tierDefault}</dd>
                  </div>
                  <div>
                    <dt>Configured</dt>
                    <dd>{row.configured}</dd>
                  </div>
                </dl>
                <p>{row.evidence}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-tier-panel" aria-labelledby="plugins-title">
        <div className="admin-tier-panel-header">
          <div>
            <p className="admin-tier-kicker">Plugins</p>
            <h2 id="plugins-title">Install permissions prompt</h2>
            <p>
              Non-official plugin installs require explicit review of requested permissions,
              capabilities, and outbound endpoints before the install tool can run.
            </p>
          </div>
        </div>
        <div className="admin-plugin-panel">
          <div className="admin-plugin-picker">
            <label>
              <span>Plugin</span>
              <select
                aria-label="Plugin to install"
                disabled={pluginCatalog.length === 0}
                onChange={(event) => setSelectedPluginId(event.target.value)}
                value={selectedPlugin?.id ?? ""}
              >
                {pluginCatalog.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>
                    {plugin.name} {plugin.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Source</span>
              <select
                aria-label="Plugin source"
                onChange={(event) => setPluginSource(event.target.value as PluginSource)}
                value={pluginSource}
              >
                <option value="official">Official Helix registry</option>
                <option value="sideload">Sideloaded bundle</option>
                <option value="self-hosted">Self-hosted registry</option>
              </select>
            </label>
          </div>

          {pluginCatalogQuery.isError ? (
            <p role="alert">Plugin catalog is unavailable or missing admin plugin scope.</p>
          ) : null}
          {pluginCatalog.length === 0 ? null : (
            <Table
              aria-label="Plugin catalog"
              className="admin-tier-table admin-plugin-table"
              role="table"
            >
              <TableHeader>
                {pluginCatalogTable.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} role="row">
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} role="columnheader">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {pluginCatalogTable.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} role="row">
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} role="cell">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {selectedPlugin === undefined ? (
            <p>No installable plugins were returned by the backend catalog.</p>
          ) : (
            <article className="admin-plugin-card">
              <header>
                <div>
                  <h3>{selectedPlugin.name}</h3>
                  <p>
                    {selectedPlugin.id} · {selectedPlugin.kind} · {selectedPlugin.version}
                  </p>
                </div>
                <span>{pluginConfirmations.length} confirmations</span>
              </header>
              <PluginManifestFacts plugin={selectedPlugin} />
              <div className="admin-plugin-confirmations">
                {pluginConfirmations.length === 0 ? (
                  <p>Official installs do not require additional source confirmations.</p>
                ) : (
                  pluginConfirmations.map((confirmation) => (
                    <label key={confirmation.id}>
                      <input
                        checked={confirmedPluginIds.has(confirmation.id)}
                        onChange={() =>
                          setConfirmedPluginRequirements((current) =>
                            current.includes(confirmation.id)
                              ? current.filter((id) => id !== confirmation.id)
                              : [...current, confirmation.id],
                          )
                        }
                        type="checkbox"
                      />
                      <span>
                        <strong>{confirmation.label}</strong>
                        {confirmation.detail}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <button
                className="helix-button"
                disabled={pluginInstallMutation.isPending || !allPluginConfirmationsAccepted}
                onClick={() =>
                  pluginInstallMutation.mutate({
                    pluginId: selectedPlugin.id,
                    version: selectedPlugin.version,
                    source: pluginSource,
                    confirmations: confirmedPluginRequirements,
                  })
                }
                type="button"
              >
                {pluginInstallMutation.isPending ? (
                  <CircleDashed aria-hidden="true" size={16} />
                ) : (
                  <ShieldCheck aria-hidden="true" size={16} />
                )}
                Install plugin
              </button>
              {pluginInstallMutation.isError ? (
                <p role="alert">Could not validate the plugin install request.</p>
              ) : null}
              {pluginInstallStatus === null ? null : (
                <p role="status">{pluginInstallStatusMessage(pluginInstallStatus)}</p>
              )}
              {pluginLifecycleMutation.isError ? (
                <p role="alert">Could not update the plugin lifecycle state.</p>
              ) : null}
              {pluginLifecycleStatus === null ? null : (
                <p role="status">{pluginLifecycleStatusMessage(pluginLifecycleStatus)}</p>
              )}
            </article>
          )}
        </div>
      </section>
    </section>
  );
}

export function aiCostAuditRowsForTier(
  tier: TierId,
  aiConfig: AIConfigStatus | undefined,
): readonly AICostAuditRow[] {
  const defaults = aiCostDefaultsByTier[tier];
  const configured = aiConfig?.costLimits;
  const audit = aiConfig?.audit;
  const privacy = aiConfig?.privacy;

  return [
    {
      id: "per-user",
      label: "User daily AI cost",
      tierDefault: formatUsdLimit(defaults?.perUserPerDayUSD),
      configured: formatUsdLimit(configured?.perUserPerDayUSD),
      evidence:
        configured?.perUserPerDayUSD === undefined ? "Using tier default" : "Live config override",
    },
    {
      id: "per-org",
      label: "Org daily AI cost",
      tierDefault: formatUsdLimit(defaults?.perOrgPerDayUSD),
      configured: formatUsdLimit(configured?.perOrgPerDayUSD),
      evidence:
        configured?.perOrgPerDayUSD === undefined ? "Using tier default" : "Live config override",
    },
    {
      id: "per-agent",
      label: "Agent daily AI cost",
      tierDefault: formatUsdLimit(defaults?.perAgentPerDayUSD),
      configured: formatUsdLimit(configured?.perAgentPerDayUSD),
      evidence:
        configured?.perAgentPerDayUSD === undefined ? "Using tier default" : "Live config override",
    },
    {
      id: "audit",
      label: "AI request audit",
      tierDefault: tier === "personal" ? "Metadata optional" : "Metadata required",
      configured:
        audit?.logRequests === undefined ? "metadata-only" : formatValue(audit.logRequests),
      evidence:
        audit?.retainDays === undefined
          ? "Retention follows platform audit policy"
          : `${String(audit.retainDays)} day retention`,
    },
    {
      id: "classification",
      label: "Classification gating",
      tierDefault: tier === "personal" ? "Optional" : "Required for external providers",
      configured: privacy?.classificationGating === false ? "Disabled" : "Enabled",
      evidence:
        privacy?.blockExternalForClassifications === undefined ||
        privacy.blockExternalForClassifications.length === 0
          ? "No external-AI classification blocks configured"
          : `Blocks ${privacy.blockExternalForClassifications.map(formatValue).join(", ")}`,
    },
  ];
}

function PluginManifestFacts({ plugin }: { readonly plugin: PluginCatalogItem }) {
  return (
    <dl className="admin-plugin-facts">
      <div>
        <dt>Scopes</dt>
        <dd>{formatList(plugin.permissions.scopes)}</dd>
      </div>
      <div>
        <dt>Outbound network</dt>
        <dd>{formatList(plugin.permissions["outbound-network"])}</dd>
      </div>
      <div>
        <dt>Provides</dt>
        <dd>{formatList(plugin.capabilities.provides)}</dd>
      </div>
      <div>
        <dt>Consumes</dt>
        <dd>{formatList(plugin.capabilities.consumes)}</dd>
      </div>
    </dl>
  );
}

function StatusIcon({ status }: { readonly status: CheckStatus }) {
  if (status === "ready") {
    return <CheckCircle2 aria-hidden="true" size={20} />;
  }

  if (status === "blocked") {
    return <AlertTriangle aria-hidden="true" size={20} />;
  }

  return <CircleDashed aria-hidden="true" size={20} />;
}

function RequirementFacts({ check }: { readonly check: RenderedReadinessCheck }) {
  if (
    check.expectedFields === undefined &&
    check.observedFields === undefined &&
    check.missing === undefined
  ) {
    return null;
  }

  return (
    <div className="admin-requirement-facts">
      <RequirementFactGroup title="Expected" fields={check.expectedFields} />
      <RequirementFactGroup title="Observed" fields={check.observedFields} />
      {check.missing === undefined ? null : (
        <div className="admin-requirement-fact-group">
          <span>Missing</span>
          <ul>
            {check.missing.map((item) => (
              <li key={item}>{formatValue(item)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RequirementFactGroup({
  title,
  fields,
}: {
  readonly title: string;
  readonly fields: readonly RequirementField[] | undefined;
}) {
  if (fields === undefined || fields.length === 0) {
    return null;
  }

  return (
    <div className="admin-requirement-fact-group">
      <span>{title}</span>
      <dl>
        {fields.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

async function fetchPlatformConfigStatus(): Promise<PlatformConfigStatus> {
  const response = await authenticatedFetch("/api/admin/platform-config");
  const output = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `Platform config request failed with ${String(response.status)}`);
  }
  if (!isPlatformConfigStatus(output)) {
    throw new Error("Platform config response was missing required fields.");
  }
  return output;
}

async function updatePlatformTier(tier: TierId): Promise<PlatformConfigStatus> {
  const payload: PlatformConfigPatch = { security: { tier } };
  const response = await authenticatedFetch("/api/admin/platform-config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const output = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `Platform config update failed with ${String(response.status)}`);
  }
  if (!isPlatformConfigStatus(output)) {
    throw new Error("Platform config response was missing required fields.");
  }
  return output;
}

async function fetchPluginCatalog(): Promise<PluginCatalogStatus> {
  const response = await authenticatedFetch("/api/tools/plugin.list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const output = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `Plugin catalog request failed with ${String(response.status)}`);
  }
  if (!isPluginCatalogStatus(output)) {
    throw new Error("Plugin catalog response was missing required fields.");
  }
  return output;
}

async function installPlugin(input: PluginInstallInput): Promise<PluginInstallResult> {
  const response = await authenticatedFetch("/api/tools/plugin.install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `Plugin install request failed with ${String(response.status)}`);
  }
  if (!isPluginInstallResult(output)) {
    throw new Error("Plugin install response was missing required fields.");
  }
  return output;
}

async function mutatePluginLifecycle(input: PluginLifecycleInput): Promise<PluginLifecycleResult> {
  const response = await authenticatedFetch(`/api/tools/plugin.${input.action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginId: input.pluginId,
      ...(input.action === "uninstall" ? { confirmations: ["plugin.uninstall"] } : {}),
    }),
  });
  const output = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(
      error ?? `Plugin ${input.action} request failed with ${String(response.status)}`,
    );
  }
  if (!isPluginLifecycleResult(output)) {
    throw new Error("Plugin lifecycle response was missing required fields.");
  }
  return output;
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
      value.status === "version_mismatch")
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
      value.status === "blocked_confirmation_required")
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

function pluginConfirmationsForSource(
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

function appendPluginConfirmations(
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

function pluginInstallStatusMessage(result: PluginInstallResult): string {
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

function pluginLifecycleStatusMessage(result: PluginLifecycleResult): string {
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

function pluginLifecycleLabel(plugin: PluginCatalogItem): string {
  if (plugin.install?.optimisticStatus === "installing") {
    return "Installing";
  }
  const lifecycle = plugin.lifecycle;
  if (lifecycle?.installed !== true) {
    return plugin.install?.optimisticStatus === "installed" ? "Installed" : "Not installed";
  }
  return formatValue(lifecycle.state);
}

function canEnablePlugin(plugin: PluginCatalogItem): boolean {
  return (
    plugin.lifecycle?.installed === true &&
    (plugin.lifecycle.state === "installed" ||
      plugin.lifecycle.state === "migrated" ||
      plugin.lifecycle.state === "disabled" ||
      plugin.lifecycle.state === "degraded")
  );
}

function canDisablePlugin(plugin: PluginCatalogItem): boolean {
  return plugin.lifecycle?.installed === true && plugin.lifecycle.state === "enabled";
}

function canUninstallPlugin(plugin: PluginCatalogItem): boolean {
  return (
    plugin.lifecycle?.installed === true &&
    plugin.lifecycle.state !== "uninstalled" &&
    plugin.lifecycle.state !== "uninstalling"
  );
}

export function readinessCheckFromBackend(requirement: BackendRequirement): RenderedReadinessCheck {
  return {
    id: requirement.key,
    title: requirement.label,
    detail: detailForBackendRequirement(requirement, fallbackBackendRequirementDetail(requirement)),
    expectedFields: formatRequirementFields(requirement.expected),
    observedFields: formatRequirementFields(requirement.observed),
    missing: requirement.missing,
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "not-required",
      sovereign: "not-required",
    },
    status: backendStatusToCheckStatus(requirement.status),
  };
}

export function readinessChecksForTier(
  tier: TierId,
  requirements: readonly BackendRequirement[] | undefined,
): readonly RenderedReadinessCheck[] {
  if (requirements === undefined) {
    return readinessChecks.map((check) => ({
      ...check,
      status: check.statusByTier[tier],
    }));
  }

  const requirementByKey = new Map(
    requirements.map((requirement) => [requirement.key, requirement]),
  );
  const mappedRequirementKeys = new Set<string>();
  const mappedChecks = readinessChecks.map((check) => {
    const requirementKey = readinessRequirementKeyByCheckId[check.id];
    const requirement =
      requirementKey === undefined ? undefined : requirementByKey.get(requirementKey);
    if (requirement === undefined) {
      return {
        ...check,
        status: check.statusByTier[tier],
      };
    }

    mappedRequirementKeys.add(requirement.key);
    return readinessCheckFromBackendRequirement(check, requirement);
  });
  const backendOnlyChecks = requirements
    .filter((requirement) => !mappedRequirementKeys.has(requirement.key))
    .map((requirement) => readinessCheckFromBackend(requirement));

  return [...mappedChecks, ...backendOnlyChecks];
}

function readinessCheckFromBackendRequirement(
  check: ReadinessCheck,
  requirement: BackendRequirement,
): RenderedReadinessCheck {
  return {
    ...check,
    detail: detailForBackendRequirement(requirement, check.detail),
    expectedFields: formatRequirementFields(requirement.expected),
    observedFields: formatRequirementFields(requirement.observed),
    missing: requirement.missing,
    status: backendStatusToCheckStatus(requirement.status),
  };
}

function detailForBackendRequirement(requirement: BackendRequirement, fallback: string): string {
  const evidence = requirement.observed.evidence;
  return typeof evidence === "string" && evidence.trim().length > 0 ? evidence : fallback;
}

function fallbackBackendRequirementDetail(requirement: BackendRequirement): string {
  return requirement.required ? "Required for the current tier." : "Not required for this tier.";
}

export function backendStatusToCheckStatus(status: BackendReadinessStatus): CheckStatus {
  if (status === "ready") {
    return "ready";
  }
  if (status === "not_required") {
    return "not-required";
  }
  return status === "missing" ? "blocked" : "warning";
}

export function serviceFromBackendRequirement(
  service: RequiredService,
  requirement: BackendRequirement | undefined,
): RenderedService {
  if (requirement === undefined) {
    return service;
  }

  return {
    ...service,
    status: serviceStatusFromBackend(requirement.status),
    backendStatus: requirement.status,
    description:
      requirement.missing === undefined || requirement.missing.length === 0
        ? service.description
        : `${service.description}; missing ${requirement.missing.map(formatValue).join(", ")}`,
  };
}

export function serviceStatusFromBackend(status: BackendReadinessStatus): ServiceStatus {
  if (status === "ready" || status === "not_required") {
    return "configured";
  }
  if (status === "missing") {
    return "missing";
  }
  return "pending";
}

export function formatRequirementFields(
  value: Record<string, unknown>,
): readonly RequirementField[] {
  return Object.entries(value).map(([key, fieldValue]) => ({
    label: formatKey(key),
    value: formatValue(fieldValue),
  }));
}

function backendStatusText(status: BackendReadinessStatus): string {
  if (status === "not_required") {
    return "Not required";
  }
  if (status === "ready") {
    return "Ready";
  }
  if (status === "missing") {
    return "Missing";
  }
  if (status === "degraded") {
    return "Degraded";
  }
  return "Unknown";
}

function titleForTier(tierId: TierId): string {
  return tiers.find((tier) => tier.id === tierId)?.title ?? tierId;
}

function formatKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (match) => match.toUpperCase());
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    return value.map(formatValue).join(", ");
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return formatToken(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "None" : values.join(", ");
}

function formatUsdLimit(value: number | undefined): string {
  if (value === undefined) {
    return "Unlimited";
  }
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatToken(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value) || value.includes("://")) {
    return value;
  }
  const normalized = value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (match) => match.toUpperCase());
  return normalized
    .replace(/\bSiem\b/gu, "SIEM")
    .replace(/\bMfa\b/gu, "MFA")
    .replace(/\bSpire\b/gu, "SPIRE");
}
