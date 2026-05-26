import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRightLeft,
  Database,
  Gauge,
  KeyRound,
  Palette,
  RefreshCcw,
  Save,
  Settings2,
  ToggleLeft,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  tenantConfigQueryKeys,
  tenantConfigQueryOptions,
  tenantStorageMigrationsQueryOptions,
  cutoverTenantStorageMigration,
  fetchTenantStorageMigration,
  requestTenantStorageMigration,
  rotateByoStorageCredentials,
  testByoStorage,
  updateTenantConfig,
  type TenantConfigAdminView,
  type RotateByoStorageCredentialsInput,
  type TenantStorageMigrationJob,
  type TenantStorageMigrationTarget,
  type TenantStorageHealthResult,
} from "./tenant-config-api";

interface TenantConfigRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof tenantConfigQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminTenantConfigQuery(queryClient: TenantConfigRouteQueryClient) {
  await queryClient.ensureQueryData(tenantConfigQueryOptions()).catch(() => undefined);
}

const BOOLEAN_FEATURE_FLAGS = [
  ["editors_native_document", "Native documents"],
  ["editors_native_spreadsheet", "Native spreadsheets"],
  ["editors_native_presentation", "Native presentations"],
  ["editors_native_pdf", "Native PDF"],
  ["editors_ai_rag", "Editors AI RAG"],
  ["ai_smart_compose", "AI smart compose"],
  ["b2b_sharing", "B2B sharing"],
  ["mail_outbound", "Outbound mail"],
  ["sso_saml", "SAML SSO"],
  ["scim_provisioning", "SCIM provisioning"],
  ["custom_domain", "Custom domains"],
  ["byo_storage", "BYO storage"],
  ["byo_database", "BYO database"],
  ["byo_kms", "BYO KMS"],
  ["byo_ai_provider", "BYO AI provider"],
  ["white_label", "White label"],
  ["multi_region_dr", "Multi-region DR"],
  ["dedicated_csm", "Dedicated CSM"],
  ["marketplace_install_paid", "Paid marketplace installs"],
] as const;

const SELECT_FEATURE_FLAGS = [
  ["dlp_enforcement", "DLP enforcement", ["off", "warn", "block"]],
  ["watermark", "Watermark", ["off", "visible", "invisible", "both"]],
  [
    "support_tier",
    "Support tier",
    ["community", "email-48h", "priority-24h", "premium-4h", "premium-1h-named"],
  ],
] as const;

const QUOTA_FIELDS = [
  ["storage_bytes_limit", "Storage bytes"],
  ["ai_tokens_monthly_limit", "AI tokens monthly"],
  ["ai_image_gen_monthly_limit", "AI images monthly"],
  ["actors_limit", "Actors"],
  ["outbound_webhooks_limit", "Outbound webhooks"],
  ["api_rps_limit", "API RPS"],
  ["collab_concurrent_editors_per_doc", "Concurrent editors per doc"],
  ["export_jobs_per_hour", "Export jobs per hour"],
] as const;

const BRANDING_FIELDS = [
  ["logo_url", "Logo URL"],
  ["accent_color_hex", "Accent color"],
  ["display_name_override", "Display name"],
  ["email_from_name", "Email from-name"],
  ["email_from_domain", "Email from-domain"],
  ["custom_domain", "Custom domain"],
] as const;

const BYO_STORAGE_PROVIDERS = [
  ["aws-s3", "AWS S3"],
  ["r2", "Cloudflare R2"],
  ["s3-compatible", "S3-compatible"],
] as const;

const BYO_STORAGE_KINDS = [
  ["helix-default", "Helix default"],
  ["byo", "Customer-owned"],
] as const;

const BYO_STORAGE_FIELDS = [
  ["endpoint", "Endpoint"],
  ["region", "Region"],
  ["bucket", "Bucket"],
  ["prefix", "Prefix"],
  ["credentials_vault_path", "Credentials Vault path"],
  ["sse_kms_key_arn", "SSE-KMS key ARN"],
] as const;

type BooleanFeatureFlagKey = (typeof BOOLEAN_FEATURE_FLAGS)[number][0];
type SelectFeatureFlagKey = (typeof SELECT_FEATURE_FLAGS)[number][0];
type FeatureFlagKey = BooleanFeatureFlagKey | SelectFeatureFlagKey;
type BrandingKey = (typeof BRANDING_FIELDS)[number][0];
type ByoStorageKind = (typeof BYO_STORAGE_KINDS)[number][0];
type ByoStorageProvider = (typeof BYO_STORAGE_PROVIDERS)[number][0];
type ByoStorageFieldKey = (typeof BYO_STORAGE_FIELDS)[number][0];

type FeatureState = Record<BooleanFeatureFlagKey, boolean> & Record<SelectFeatureFlagKey, string>;
type BrandingState = Record<BrandingKey, string>;
type ByoStorageState = Record<ByoStorageFieldKey, string> & {
  readonly kind: ByoStorageKind;
  readonly provider: ByoStorageProvider;
  readonly force_path_style: boolean;
};
type ByoStorageCredentialsState = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
};

const emptyFeatureState = {
  ...Object.fromEntries(BOOLEAN_FEATURE_FLAGS.map(([key]) => [key, false])),
  ...Object.fromEntries(SELECT_FEATURE_FLAGS.map(([key, , options]) => [key, options[0]])),
} as FeatureState;
const emptyBrandingState = Object.fromEntries(
  BRANDING_FIELDS.map(([key]) => [key, ""]),
) as BrandingState;
const emptyByoStorageState = {
  kind: "helix-default",
  provider: "aws-s3",
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  prefix: "",
  credentials_vault_path: "",
  sse_kms_key_arn: "",
  force_path_style: false,
} satisfies ByoStorageState;
const emptyByoStorageCredentialsState = {
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
} satisfies ByoStorageCredentialsState;

export function TenantConfigManagement() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureState>(emptyFeatureState);
  const [dirtyFeatureKeys, setDirtyFeatureKeys] = useState<ReadonlySet<FeatureFlagKey>>(new Set());
  const [branding, setBranding] = useState<BrandingState>(emptyBrandingState);
  const [byoStorage, setByoStorage] = useState<ByoStorageState>(emptyByoStorageState);
  const [byoStorageCredentials, setByoStorageCredentials] = useState<ByoStorageCredentialsState>(
    emptyByoStorageCredentialsState,
  );
  const [credentialRotationConfirmed, setCredentialRotationConfirmed] = useState(false);
  const [credentialRotationStatus, setCredentialRotationStatus] = useState<string | null>(null);
  const [storageHealth, setStorageHealth] = useState<TenantStorageHealthResult | null>(null);
  const [migrationTarget, setMigrationTarget] = useState<TenantStorageMigrationTarget>("byo");
  const [migrationDryRun, setMigrationDryRun] = useState(true);
  const [migrationRequestConfirmed, setMigrationRequestConfirmed] = useState(false);
  const [migrationCutoverConfirmed, setMigrationCutoverConfirmed] = useState(false);
  const [storageMigration, setStorageMigration] = useState<TenantStorageMigrationJob | null>(null);
  const query = useQuery(tenantConfigQueryOptions());
  const storageMigrationHistoryQuery = useQuery(tenantStorageMigrationsQueryOptions());

  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    setFeatures(featureStateFromConfig(query.data));
    setDirtyFeatureKeys(new Set());
    setBranding(brandingStateFromConfig(query.data));
    setByoStorage(byoStorageStateFromConfig(query.data));
    setByoStorageCredentials(emptyByoStorageCredentialsState);
    setCredentialRotationConfirmed(false);
    setCredentialRotationStatus(null);
    setMigrationTarget(defaultMigrationTarget(query.data));
    setMigrationRequestConfirmed(false);
    setMigrationCutoverConfirmed(false);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof updateTenantConfig>[0]) => updateTenantConfig(input),
    onMutate: () => {
      setError(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update tenant settings.",
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.detail() });
    },
  });
  const storageTestMutation = useMutation({
    mutationFn: () => testByoStorage(),
    onMutate: () => {
      setError(null);
      setStorageHealth(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error ? mutationError.message : "Failed to test BYO storage.",
      );
    },
    onSuccess: (health) => {
      setStorageHealth(health);
    },
  });
  const storageCredentialMutation = useMutation({
    mutationFn: (input: RotateByoStorageCredentialsInput) => rotateByoStorageCredentials(input),
    onMutate: () => {
      setError(null);
      setStorageHealth(null);
      setCredentialRotationStatus(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to rotate BYO storage credentials.",
      );
    },
    onSuccess: (result) => {
      setByoStorageCredentials(emptyByoStorageCredentialsState);
      setCredentialRotationConfirmed(false);
      setCredentialRotationStatus(`Credential rotation ${result.health.status}.`);
      setStorageHealth(result.health);
    },
  });
  const storageMigrationMutation = useMutation({
    mutationFn: () => requestTenantStorageMigration(buildStorageMigrationRequest()),
    onMutate: () => {
      setError(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to request tenant storage migration.",
      );
    },
    onSuccess: (migration) => {
      setStorageMigration(migration);
      setMigrationCutoverConfirmed(false);
      void queryClient.invalidateQueries({
        queryKey: tenantConfigQueryKeys.storageMigrations(),
      });
    },
  });
  const storageMigrationStatusMutation = useMutation({
    mutationFn: (id: string) => fetchTenantStorageMigration(id),
    onMutate: () => {
      setError(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to refresh tenant storage migration status.",
      );
    },
    onSuccess: (migration) => {
      setStorageMigration(migration);
      setMigrationCutoverConfirmed(false);
      void queryClient.invalidateQueries({
        queryKey: tenantConfigQueryKeys.storageMigrations(),
      });
    },
  });
  const storageMigrationCutoverMutation = useMutation({
    mutationFn: (id: string) => cutoverTenantStorageMigration(id),
    onMutate: () => {
      setError(null);
    },
    onError: (mutationError: unknown) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to cut over tenant storage migration.",
      );
    },
    onSuccess: async (result) => {
      setStorageMigration(result.migration);
      setMigrationCutoverConfirmed(false);
      queryClient.setQueryData(tenantConfigQueryKeys.detail(), result.tenantConfig);
      await queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.storageMigrations() });
      await queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.detail() });
    },
  });

  const canSave =
    !mutation.isPending &&
    !storageTestMutation.isPending &&
    !storageCredentialMutation.isPending &&
    !storageMigrationMutation.isPending &&
    !storageMigrationStatusMutation.isPending &&
    !storageMigrationCutoverMutation.isPending &&
    !query.isLoading;
  const canRequestMigration = canSave && (migrationDryRun || migrationRequestConfirmed);
  const canCutoverMigration =
    canSave &&
    migrationCutoverConfirmed &&
    storageMigration !== null &&
    !storageMigration.dryRun &&
    storageMigration.status === "succeeded" &&
    storageMigration.failures.length === 0 &&
    storageMigration.lastError === null &&
    storageMigration.plannedCount === storageMigration.copiedCount &&
    storageMigration.plannedCount === storageMigration.verifiedCount;
  const canRotateCredentials = canSave && credentialRotationConfirmed && byoStorage.kind === "byo";
  const orgId = query.data?.orgId ?? "tenant";
  const booleanFeatureRows = useMemo(() => [...BOOLEAN_FEATURE_FLAGS], []);
  const selectFeatureRows = useMemo(() => [...SELECT_FEATURE_FLAGS], []);
  const quotaRows = useMemo(() => [...QUOTA_FIELDS], []);
  const brandingRows = useMemo(() => [...BRANDING_FIELDS], []);
  const byoStorageRows = useMemo(() => [...BYO_STORAGE_FIELDS], []);
  const byoStorageKinds = useMemo(() => [...BYO_STORAGE_KINDS], []);
  const saveFeatures = () => {
    if (dirtyFeatureKeys.size === 0) {
      return;
    }
    const featurePatch = Object.fromEntries(
      [...dirtyFeatureKeys].map((key) => [key, features[key]]),
    );
    mutation.mutate(
      {
        features: featurePatch,
        reason: "admin settings update: features",
      },
      {
        onSuccess: () => {
          setDirtyFeatureKeys(new Set());
        },
      },
    );
  };
  const saveBranding = () => {
    mutation.mutate({
      branding: compactBlankStrings(branding),
      reason: "admin settings update: branding",
    });
  };
  const saveByoStorage = () => {
    const parsed = parseByoStorage(byoStorage);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setError(null);
    const input: Parameters<typeof updateTenantConfig>[0] = {
      byo: { storage: parsed },
      ...(parsed.kind === "byo"
        ? {
            features: {
              byo_storage: true,
            },
          }
        : {}),
      reason: "admin settings update: byo storage",
    };
    mutation.mutate(input);
  };
  const testStorage = () => {
    setError(null);
    storageTestMutation.mutate();
  };
  const rotateStorageCredentials = () => {
    const credentials = byoStorageCredentialsPayload(byoStorageCredentials);
    if (typeof credentials === "string") {
      setError(credentials);
      return;
    }
    setError(null);
    storageCredentialMutation.mutate({
      credentials,
      reason: "admin settings update: byo storage credentials",
    });
  };
  const requestStorageMigration = () => {
    setError(null);
    try {
      storageMigrationMutation.mutate();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Failed to prepare tenant storage migration request.",
      );
    }
  };
  const refreshStorageMigration = () => {
    if (storageMigration === null) {
      return;
    }
    storageMigrationStatusMutation.mutate(storageMigration.id);
  };
  const refreshStorageMigrationJob = (id: string) => {
    storageMigrationStatusMutation.mutate(id);
  };
  const cutoverStorageMigration = () => {
    if (storageMigration === null) {
      return;
    }
    storageMigrationCutoverMutation.mutate(storageMigration.id);
  };

  function buildStorageMigrationRequest(): Parameters<typeof requestTenantStorageMigration>[0] {
    if (migrationTarget === "byo") {
      const parsed = parseByoStorage({ ...byoStorage, kind: "byo" });
      if (typeof parsed === "string") {
        throw new Error(parsed);
      }
      if (parsed.kind !== "byo") {
        throw new Error("Set storage mode to Customer-owned before migrating to BYO storage.");
      }
      return {
        target: "byo",
        dryRun: migrationDryRun,
        targetStorage: parsed,
      };
    }
    const parsed = parseByoStorage(byoStorage);
    return {
      target: "helix-default",
      dryRun: migrationDryRun,
      ...(typeof parsed === "string" || parsed.kind !== "byo" ? {} : { sourceStorage: parsed }),
    };
  }

  return (
    <section aria-labelledby="tenant-settings-title" className="grid gap-4">
      <header className="flex items-start gap-2">
        <Settings2 aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
        <div>
          <h3 id="tenant-settings-title" className="text-sm font-medium">
            Tenant settings
          </h3>
          <p className="text-xs text-muted-foreground">
            Tenant <code>{orgId}</code>
          </p>
        </div>
      </header>

      {error !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {query.isError ? (
        <p className="text-xs text-muted-foreground" role="status">
          Tenant settings are unavailable.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
          <form
            aria-label="Feature flags"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
            onSubmit={(event) => {
              event.preventDefault();
              saveFeatures();
            }}
          >
            <SectionHeader icon={<ToggleLeft aria-hidden="true" />} title="Feature flags" />
            <div className="grid gap-2">
              {booleanFeatureRows.map(([key, label]) => (
                <label
                  key={key}
                  className="flex min-h-8 items-center justify-between gap-3 text-sm"
                >
                  <span>{label}</span>
                  <input
                    checked={features[key]}
                    className="size-4"
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setFeatures((current) => ({ ...current, [key]: checked }));
                      setDirtyFeatureKeys((current) => new Set(current).add(key));
                    }}
                    type="checkbox"
                  />
                </label>
              ))}
              {selectFeatureRows.map(([key, label, options]) => (
                <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                  <span>{label}</span>
                  <select
                    className="h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setFeatures((current) => ({
                        ...current,
                        [key]: value,
                      }));
                      setDirtyFeatureKeys((current) => new Set(current).add(key));
                    }}
                    value={features[key]}
                  >
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <SaveButton disabled={!canSave} label="Save feature flags" onClick={saveFeatures} />
          </form>

          <form
            aria-label="Quotas"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <SectionHeader icon={<Gauge aria-hidden="true" />} title="Quotas" />
            <p className="text-xs text-muted-foreground">
              {query.data?.plan === null || query.data?.plan === undefined
                ? "Effective limits are shown from system defaults and tenant overrides."
                : `${query.data.plan.displayName} plan defaults with tenant overrides applied.`}
            </p>
            <div className="grid gap-2" role="list">
              {quotaRows.map(([key, label]) => (
                <QuotaRow
                  key={key}
                  effective={query.data?.effective.quotas[key]}
                  label={label}
                  override={query.data?.quotas[key]}
                  planDefault={query.data?.plan?.quotasDefault[key]}
                />
              ))}
            </div>
          </form>

          <form
            aria-label="Branding"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
            onSubmit={(event) => {
              event.preventDefault();
              saveBranding();
            }}
          >
            <SectionHeader icon={<Palette aria-hidden="true" />} title="Branding" />
            <div className="grid gap-2">
              {brandingRows.map(([key, label]) => (
                <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                  <span>{label}</span>
                  <Input
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setBranding((current) => ({
                        ...current,
                        [key]: value,
                      }));
                    }}
                    placeholder={brandingPlaceholder(key)}
                    type="text"
                    value={branding[key]}
                  />
                </label>
              ))}
            </div>
            <SaveButton disabled={!canSave} label="Save branding" onClick={saveBranding} />
          </form>

          <form
            aria-label="BYO storage"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
            onSubmit={(event) => {
              event.preventDefault();
              saveByoStorage();
            }}
          >
            <SectionHeader icon={<Database aria-hidden="true" />} title="BYO storage" />
            <label className="grid gap-1 text-xs text-muted-foreground">
              <span>Storage mode</span>
              <select
                className="h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                onChange={(event) => {
                  const kind = event.currentTarget.value as ByoStorageKind;
                  setByoStorage((current) => ({
                    ...current,
                    kind,
                  }));
                }}
                value={byoStorage.kind}
              >
                {byoStorageKinds.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              <span>Provider</span>
              <select
                className="h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                onChange={(event) => {
                  const provider = event.currentTarget.value as ByoStorageProvider;
                  setByoStorage((current) => ({
                    ...current,
                    provider,
                    force_path_style: provider !== "aws-s3",
                  }));
                }}
                value={byoStorage.provider}
                disabled={byoStorage.kind === "helix-default"}
              >
                {BYO_STORAGE_PROVIDERS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2">
              {byoStorageRows.map(([key, label]) => (
                <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                  <span>{label}</span>
                  <Input
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setByoStorage((current) => ({
                        ...current,
                        [key]: value,
                      }));
                    }}
                    placeholder={byoStoragePlaceholder(key, byoStorage.provider)}
                    type="text"
                    value={byoStorage[key]}
                    disabled={byoStorage.kind === "helix-default" && key !== "prefix"}
                  />
                </label>
              ))}
            </div>
            <label className="flex min-h-8 items-center justify-between gap-3 text-sm">
              <span>Force path-style S3</span>
              <input
                checked={byoStorage.force_path_style}
                className="size-4"
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setByoStorage((current) => ({
                    ...current,
                    force_path_style: checked,
                  }));
                }}
                type="checkbox"
                disabled={byoStorage.kind === "helix-default"}
              />
            </label>
            <SaveButton disabled={!canSave} label="Save BYO storage" onClick={saveByoStorage} />
            <Button disabled={!canSave} onClick={testStorage} size="sm" type="button">
              <Activity aria-hidden="true" />
              {storageTestMutation.isPending ? "Testing storage" : "Test storage"}
            </Button>
            <div className="grid gap-3 border-t border-border/70 pt-3">
              <SectionHeader icon={<KeyRound aria-hidden="true" />} title="Storage credentials" />
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>Access key ID</span>
                <Input
                  autoComplete="off"
                  disabled={byoStorage.kind === "helix-default"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setByoStorageCredentials((current) => ({
                      ...current,
                      accessKeyId: value,
                    }));
                  }}
                  type="text"
                  value={byoStorageCredentials.accessKeyId}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>Secret access key</span>
                <Input
                  autoComplete="new-password"
                  disabled={byoStorage.kind === "helix-default"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setByoStorageCredentials((current) => ({
                      ...current,
                      secretAccessKey: value,
                    }));
                  }}
                  type="password"
                  value={byoStorageCredentials.secretAccessKey}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>Session token</span>
                <Input
                  autoComplete="new-password"
                  disabled={byoStorage.kind === "helix-default"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setByoStorageCredentials((current) => ({
                      ...current,
                      sessionToken: value,
                    }));
                  }}
                  type="password"
                  value={byoStorageCredentials.sessionToken}
                />
              </label>
              <label className="flex min-h-8 items-center justify-between gap-3 text-sm">
                <span>Confirm credential rotation</span>
                <input
                  checked={credentialRotationConfirmed}
                  className="size-4"
                  disabled={byoStorage.kind === "helix-default"}
                  onChange={(event) => {
                    setCredentialRotationConfirmed(event.currentTarget.checked);
                  }}
                  type="checkbox"
                />
              </label>
              <Button
                disabled={!canRotateCredentials}
                onClick={rotateStorageCredentials}
                size="sm"
                type="button"
              >
                <KeyRound aria-hidden="true" />
                {storageCredentialMutation.isPending
                  ? "Rotating credentials"
                  : "Rotate credentials"}
              </Button>
              {credentialRotationStatus === null ? null : (
                <p className="text-xs text-muted-foreground" role="status">
                  {credentialRotationStatus}
                </p>
              )}
            </div>
            {storageHealth === null ? null : (
              <p className="text-xs text-muted-foreground" role="status">
                {storageHealth.status}: {storageHealth.message}
                {storageHealth.managedBy === undefined ? "" : ` (${storageHealth.managedBy})`}
                {storageHealth.prefix === undefined ? "" : ` prefix ${storageHealth.prefix}`}
              </p>
            )}
            <div className="grid gap-3 border-t border-border/70 pt-3">
              <SectionHeader
                icon={<ArrowRightLeft aria-hidden="true" />}
                title="Storage migration"
              />
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>Migration target</span>
                <select
                  className="h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  onChange={(event) => {
                    setMigrationTarget(event.currentTarget.value as TenantStorageMigrationTarget);
                    setMigrationRequestConfirmed(false);
                  }}
                  value={migrationTarget}
                >
                  <option value="byo">Customer-owned storage</option>
                  <option value="helix-default">Helix default storage</option>
                </select>
              </label>
              <label className="flex min-h-8 items-center justify-between gap-3 text-sm">
                <span>Dry run only</span>
                <input
                  checked={migrationDryRun}
                  className="size-4"
                  onChange={(event) => {
                    setMigrationDryRun(event.currentTarget.checked);
                    setMigrationRequestConfirmed(false);
                  }}
                  type="checkbox"
                />
              </label>
              <label className="flex min-h-8 items-center justify-between gap-3 text-sm">
                <span>Confirm live migration request</span>
                <input
                  checked={migrationRequestConfirmed}
                  className="size-4"
                  disabled={migrationDryRun}
                  onChange={(event) => {
                    setMigrationRequestConfirmed(event.currentTarget.checked);
                  }}
                  type="checkbox"
                />
              </label>
              <Button
                disabled={!canRequestMigration}
                onClick={requestStorageMigration}
                size="sm"
                type="button"
              >
                <ArrowRightLeft aria-hidden="true" />
                {storageMigrationMutation.isPending ? "Requesting migration" : "Request migration"}
              </Button>
              {storageMigration === null ? null : (
                <div
                  className="grid gap-2 rounded-md border border-border/70 px-3 py-2 text-xs"
                  role="status"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-foreground">
                      {formatMigrationStatus(storageMigration.status)}
                    </span>
                    <Button
                      disabled={!canSave}
                      onClick={refreshStorageMigration}
                      size="sm"
                      type="button"
                    >
                      <RefreshCcw aria-hidden="true" />
                      {storageMigrationStatusMutation.isPending ? "Refreshing" : "Refresh status"}
                    </Button>
                  </div>
                  <span>
                    Target {formatMigrationTarget(storageMigration.target)}
                    {storageMigration.dryRun ? " dry run" : " live migration"}
                  </span>
                  <span>
                    Planned {storageMigration.plannedCount}, copied {storageMigration.copiedCount},
                    verified {storageMigration.verifiedCount}
                  </span>
                  <span>
                    Source {storageMigration.sourceStorage?.managedBy ?? "unknown"} to target{" "}
                    {storageMigration.targetStorage?.managedBy ?? "unknown"}
                  </span>
                  {storageMigration.lastError === null ? null : (
                    <span className="text-destructive">{storageMigration.lastError}</span>
                  )}
                  {storageMigration.failures.length === 0 ? null : (
                    <span className="text-destructive">
                      {storageMigration.failures.length} object failure
                      {storageMigration.failures.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {!storageMigration.dryRun && storageMigration.status === "succeeded" ? (
                    <div className="grid gap-2 border-t border-border/70 pt-2">
                      <label className="flex min-h-8 items-center justify-between gap-3 text-sm">
                        <span>Confirm migration cutover</span>
                        <input
                          checked={migrationCutoverConfirmed}
                          className="size-4"
                          onChange={(event) => {
                            setMigrationCutoverConfirmed(event.currentTarget.checked);
                          }}
                          type="checkbox"
                        />
                      </label>
                      <Button
                        disabled={!canCutoverMigration}
                        onClick={cutoverStorageMigration}
                        size="sm"
                        type="button"
                      >
                        <ArrowRightLeft aria-hidden="true" />
                        {storageMigrationCutoverMutation.isPending
                          ? "Cutting over"
                          : "Cut over storage"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
              <div className="grid gap-2 border-t border-border/70 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <SectionHeader
                    icon={<RefreshCcw aria-hidden="true" />}
                    title="Migration history"
                  />
                  <Button
                    disabled={storageMigrationHistoryQuery.isFetching}
                    onClick={() =>
                      void queryClient.invalidateQueries({
                        queryKey: tenantConfigQueryKeys.storageMigrations(),
                      })
                    }
                    size="sm"
                    type="button"
                  >
                    <RefreshCcw aria-hidden="true" />
                    {storageMigrationHistoryQuery.isFetching ? "Loading" : "Refresh history"}
                  </Button>
                </div>
                {storageMigrationHistoryQuery.isError ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    Storage migration history unavailable.
                  </p>
                ) : storageMigrationHistoryQuery.data === undefined ||
                  storageMigrationHistoryQuery.data.migrations.length === 0 ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    No storage migration jobs yet.
                  </p>
                ) : (
                  <div className="grid gap-2" role="list">
                    {storageMigrationHistoryQuery.data.migrations.map((migration) => (
                      <div
                        className={`grid gap-1 rounded-md border px-3 py-2 text-xs ${
                          storageMigration?.id === migration.id
                            ? "border-ring bg-surface-container"
                            : "border-border/70"
                        }`}
                        key={migration.id}
                        role="listitem"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-foreground">
                            {formatMigrationStatus(migration.status)}
                          </span>
                          <Button
                            disabled={!canSave}
                            onClick={() => {
                              refreshStorageMigrationJob(migration.id);
                            }}
                            size="sm"
                            type="button"
                          >
                            <RefreshCcw aria-hidden="true" />
                            Refresh job
                          </Button>
                        </div>
                        <span>
                          Target {formatMigrationTarget(migration.target)}
                          {migration.dryRun ? " dry run" : " live migration"}
                        </span>
                        <span>
                          Planned {migration.plannedCount}, copied {migration.copiedCount}, verified{" "}
                          {migration.verifiedCount}
                        </span>
                        <span>
                          Source {migration.sourceStorage?.managedBy ?? "unknown"} to target{" "}
                          {migration.targetStorage?.managedBy ?? "unknown"}
                        </span>
                        <span>
                          Created {formatTimestamp(migration.createdAt)}
                          {migration.completedAt === null
                            ? ""
                            : `, completed ${formatTimestamp(migration.completedAt)}`}
                        </span>
                        {migration.lastError === null ? null : (
                          <span className="text-destructive">{migration.lastError}</span>
                        )}
                        {migration.failures.length === 0 ? null : (
                          <span className="text-destructive">
                            {migration.failures.length} object failure
                            {migration.failures.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {storageMigrationHistoryQuery.data?.nextCursor === null ||
                storageMigrationHistoryQuery.data?.nextCursor === undefined ? null : (
                  <p className="text-xs text-muted-foreground" role="status">
                    More migration jobs are available in history.
                  </p>
                )}
              </div>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function SectionHeader({ icon, title }: { readonly icon: ReactNode; readonly title: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold">
      <span className="[&_svg]:size-4">{icon}</span>
      {title}
    </h4>
  );
}

function QuotaRow({
  effective,
  label,
  override,
  planDefault,
}: {
  readonly effective: unknown;
  readonly label: string;
  readonly override: unknown;
  readonly planDefault: unknown;
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md border border-border/70 px-3 py-2 text-xs"
      role="listitem"
    >
      <span className="font-medium text-foreground">{label}</span>
      <span className="font-mono text-sm text-foreground">{formatQuotaValue(effective)}</span>
      <span className="text-muted-foreground">Plan</span>
      <span className="text-right text-muted-foreground">{formatQuotaValue(planDefault)}</span>
      {override === undefined ? null : (
        <>
          <span className="text-muted-foreground">Override</span>
          <span className="text-right text-muted-foreground">{formatQuotaValue(override)}</span>
        </>
      )}
    </div>
  );
}

function SaveButton({
  disabled,
  label,
  onClick,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button disabled={disabled} onClick={onClick} size="sm" type="button">
      <Save aria-hidden="true" />
      {label}
    </Button>
  );
}

function featureStateFromConfig(config: TenantConfigAdminView): FeatureState {
  return {
    ...Object.fromEntries(
      BOOLEAN_FEATURE_FLAGS.map(([key]) => [key, config.features[key] === true]),
    ),
    ...Object.fromEntries(
      SELECT_FEATURE_FLAGS.map(([key, , options]) => [
        key,
        typeof config.features[key] === "string" &&
        (options as readonly string[]).includes(config.features[key])
          ? config.features[key]
          : options[0],
      ]),
    ),
  } as FeatureState;
}

function brandingStateFromConfig(config: TenantConfigAdminView): BrandingState {
  return Object.fromEntries(
    BRANDING_FIELDS.map(([key]) => [
      key,
      typeof config.branding[key] === "string" ? config.branding[key] : "",
    ]),
  ) as BrandingState;
}

function byoStorageStateFromConfig(config: TenantConfigAdminView): ByoStorageState {
  const storage = readRecord(config.byo.storage);
  const encryption = readRecord(storage?.encryption);
  const kind = storage?.kind === "byo" ? "byo" : "helix-default";
  const provider = readByoStorageProvider(storage?.provider);
  return {
    kind,
    provider,
    endpoint: typeof storage?.endpoint === "string" ? storage.endpoint : "",
    region: typeof storage?.region === "string" ? storage.region : "us-east-1",
    bucket: typeof storage?.bucket === "string" ? storage.bucket : "",
    prefix: typeof storage?.prefix === "string" ? storage.prefix : "",
    credentials_vault_path:
      typeof storage?.credentials_vault_path === "string" ? storage.credentials_vault_path : "",
    sse_kms_key_arn:
      typeof encryption?.sse_kms_key_arn === "string" ? encryption.sse_kms_key_arn : "",
    force_path_style:
      typeof storage?.force_path_style === "boolean"
        ? storage.force_path_style
        : provider !== "aws-s3",
  };
}

function defaultMigrationTarget(config: TenantConfigAdminView): TenantStorageMigrationTarget {
  const storage = readRecord(config.byo.storage);
  return storage?.kind === "byo" ? "helix-default" : "byo";
}

function compactBlankStrings(input: BrandingState): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key] of BRANDING_FIELDS) {
    const value = input[key].trim();
    if (value.length > 0) {
      output[key] = value;
    }
  }
  return output;
}

function parseByoStorage(input: ByoStorageState):
  | {
      readonly kind: ByoStorageKind;
      readonly [key: string]: string | boolean | { readonly sse_kms_key_arn: string };
    }
  | string {
  const bucket = input.bucket.trim();
  const credentialsVaultPath = input.credentials_vault_path.trim();
  const endpoint = input.endpoint.trim();
  const region = input.region.trim();
  const prefix = input.prefix.trim();
  const sseKmsKeyArn = input.sse_kms_key_arn.trim();
  if (unsafeStoragePrefix(prefix)) {
    return "BYO storage prefix must not contain path traversal, repeated separators, or control characters.";
  }
  if (input.kind === "helix-default") {
    return {
      kind: "helix-default",
      ...(prefix.length === 0 ? {} : { prefix }),
    };
  }
  if (bucket.length === 0) {
    return "BYO storage bucket is required.";
  }
  if (!/^tenants\/[A-Za-z0-9_-]+\/byo-storage\/[A-Za-z0-9_.-]+$/u.test(credentialsVaultPath)) {
    return "Credentials Vault path must be scoped under tenants/{tenant}/byo-storage/.";
  }
  if (input.provider !== "aws-s3" && endpoint.length === 0) {
    return "BYO storage endpoint is required for this provider.";
  }
  return {
    kind: "byo",
    provider: input.provider,
    ...(endpoint.length === 0 ? {} : { endpoint }),
    ...(region.length === 0 ? {} : { region }),
    bucket,
    ...(prefix.length === 0 ? {} : { prefix }),
    credentials_vault_path: credentialsVaultPath,
    force_path_style: input.force_path_style,
    ...(sseKmsKeyArn.length === 0
      ? {}
      : {
          encryption: {
            sse_kms_key_arn: sseKmsKeyArn,
          },
        }),
  };
}

function byoStorageCredentialsPayload(
  input: ByoStorageCredentialsState,
): RotateByoStorageCredentialsInput["credentials"] | string {
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const sessionToken = input.sessionToken.trim();
  if (accessKeyId.length === 0) {
    return "Access key ID is required.";
  }
  if (secretAccessKey.length === 0) {
    return "Secret access key is required.";
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken.length === 0 ? {} : { sessionToken }),
  };
}

function formatQuotaValue(value: unknown): string {
  return typeof value === "number" ? new Intl.NumberFormat("en-US").format(value) : "unlimited";
}

function formatMigrationStatus(status: TenantStorageMigrationJob["status"]): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatMigrationTarget(target: TenantStorageMigrationTarget): string {
  return target === "byo" ? "customer-owned storage" : "Helix default storage";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function brandingPlaceholder(key: BrandingKey): string | undefined {
  if (key === "accent_color_hex") {
    return "#2f6fed";
  }
  if (key === "logo_url") {
    return "https://example.com/logo.png";
  }
  return undefined;
}

function byoStoragePlaceholder(key: ByoStorageFieldKey, provider: ByoStorageProvider): string {
  switch (key) {
    case "endpoint":
      return provider === "aws-s3"
        ? "https://s3.amazonaws.com"
        : "https://account.r2.cloudflarestorage.com";
    case "region":
      return "us-east-1";
    case "bucket":
      return "acme-helix-data";
    case "prefix":
      return "helix/";
    case "credentials_vault_path":
      return "tenants/acme/byo-storage/s3";
    case "sse_kms_key_arn":
      return "arn:aws:kms:us-east-1:123456789012:key/...";
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readByoStorageProvider(value: unknown): ByoStorageProvider {
  return value === "aws-s3" || value === "r2" || value === "s3-compatible" ? value : "aws-s3";
}

function unsafeStoragePrefix(value: string): boolean {
  const trimmed = value.trim().replace(/^\/+/u, "");
  return (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("//") ||
    hasControlCharacter(trimmed)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
