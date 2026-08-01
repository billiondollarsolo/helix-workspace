import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRightLeft,
  ChevronRight,
  Database,
  Gauge,
  Palette,
  RefreshCcw,
  Save,
  ToggleLeft,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  tenantConfigQueryKeys,
  tenantConfigQueryOptions,
  cutoverTenantStorageMigration,
  fetchTenantStorageMigration,
  requestTenantStorageMigration,
  testByoStorage,
  updateTenantConfig,
  type TenantConfigAdminView,
  type TenantStorageMigrationJob,
  type TenantStorageMigrationTarget,
  type TenantStorageHealthResult,
} from "./tenant-config-api";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { PageHeading } from "@/features/admin/console/primitives";

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

/** Boolean flags grouped for display.
 *
 *  Nineteen checkboxes in one undifferentiated column gave no hint that the
 *  four `byo_*` flags are one decision, or that the editor flags gate a single
 *  product surface. Keys only — labels come from `BOOLEAN_FEATURE_FLAGS` above
 *  so there is one place to edit them. `tenant-config-management.test.tsx`
 *  asserts the groups partition the flag list exactly, so adding a flag
 *  without placing it fails rather than quietly disappearing from the form. */
export const BOOLEAN_FEATURE_FLAG_GROUPS = [
  {
    title: "Editors",
    keys: [
      "editors_native_document",
      "editors_native_spreadsheet",
      "editors_native_presentation",
      "editors_native_pdf",
    ],
  },
  { title: "AI", keys: ["editors_ai_rag", "ai_smart_compose"] },
  { title: "Sharing & mail", keys: ["b2b_sharing", "mail_outbound"] },
  { title: "Identity", keys: ["sso_saml", "scim_provisioning", "custom_domain"] },
  {
    title: "Bring your own",
    keys: ["byo_storage", "byo_database", "byo_kms", "byo_ai_provider"],
  },
  {
    title: "Plan entitlements",
    keys: ["white_label", "multi_region_dr", "dedicated_csm", "marketplace_install_paid"],
  },
] as const satisfies ReadonlyArray<{
  readonly title: string;
  readonly keys: readonly string[];
}>;

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

/** Flag key -> display label, so the grouped form can render by key. */
const BOOLEAN_FEATURE_FLAG_LABELS = new Map<string, string>(BOOLEAN_FEATURE_FLAGS);

/** Every boolean flag key. Exported so the test can check that
 *  `BOOLEAN_FEATURE_FLAG_GROUPS` partitions this list exactly. */
export const BOOLEAN_FEATURE_FLAG_KEYS: readonly BooleanFeatureFlagKey[] =
  BOOLEAN_FEATURE_FLAGS.map(([key]) => key);
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

export function TenantConfigManagement() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureState>(emptyFeatureState);
  const [dirtyFeatureKeys, setDirtyFeatureKeys] = useState<ReadonlySet<FeatureFlagKey>>(new Set());
  const [branding, setBranding] = useState<BrandingState>(emptyBrandingState);
  const [byoStorage, setByoStorage] = useState<ByoStorageState>(emptyByoStorageState);
  const [storageHealth, setStorageHealth] = useState<TenantStorageHealthResult | null>(null);
  const [migrationTarget, setMigrationTarget] = useState<TenantStorageMigrationTarget>("byo");
  const [migrationDryRun, setMigrationDryRun] = useState(true);
  const [migrationRequestConfirmed, setMigrationRequestConfirmed] = useState(false);
  const [storageMigration, setStorageMigration] = useState<TenantStorageMigrationJob | null>(null);
  /* Holds the job the confirmation was opened for, rather than a bare boolean:
     the operator consents to the counts they were shown, and a status refresh
     landing mid-decision must not swap the job out from under the dialog. */
  const [cutoverTarget, setCutoverTarget] = useState<TenantStorageMigrationJob | null>(null);
  const query = useQuery(tenantConfigQueryOptions());
  const storageFieldsRef = useRef<HTMLDetailsElement>(null);
  const migrationRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    setFeatures(featureStateFromConfig(query.data));
    setDirtyFeatureKeys(new Set());
    setBranding(brandingStateFromConfig(query.data));
    setByoStorage(byoStorageStateFromConfig(query.data));
    setMigrationTarget(defaultMigrationTarget(query.data));
    setMigrationRequestConfirmed(false);
    setCutoverTarget(null);
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
      // A newly requested job is not the job any open confirmation was for.
      setCutoverTarget(null);
      revealDetails(migrationRef);
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
      // Refreshed counts are new evidence; consent has to be re-taken against them.
      setCutoverTarget(null);
      revealDetails(migrationRef);
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
      queryClient.setQueryData(tenantConfigQueryKeys.detail(), result.tenantConfig);
      await queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.detail() });
    },
  });

  const canSave =
    !mutation.isPending &&
    !storageTestMutation.isPending &&
    !storageMigrationMutation.isPending &&
    !storageMigrationStatusMutation.isPending &&
    !storageMigrationCutoverMutation.isPending &&
    !query.isLoading;
  const canRequestMigration = canSave && (migrationDryRun || migrationRequestConfirmed);
  const cutoverBlocker = storageMigration === null ? null : cutoverBlockerFor(storageMigration);
  const canCutoverMigration =
    canSave &&
    storageMigration !== null &&
    storageMigration.dryRun === false &&
    storageMigration.status === "succeeded" &&
    cutoverBlocker === null;
  /* No `?? "tenant"` fallback. That literal was printed as this workspace's
     identifier AND handed to the cutover dialog as its `confirmPhrase`, so an
     operator whose config had not loaded would have been asked to type the
     word "tenant" to authorise repointing every object read in the tenant. */
  const orgId = query.data?.orgId ?? null;
  const selectFeatureRows = useMemo(() => [...SELECT_FEATURE_FLAGS], []);
  const quotaRows = useMemo(() => [...QUOTA_FIELDS], []);
  const brandingRows = useMemo(() => [...BRANDING_FIELDS], []);
  const byoStorageRows = useMemo(() => [...BYO_STORAGE_FIELDS], []);
  const byoStorageKinds = useMemo(() => [...BYO_STORAGE_KINDS], []);

  /* Disclosure defaults are derived from the *loaded config*, never from live
     form state. React writes a DOM prop only when it changes between renders,
     so a value that is stable after load lets the operator's own open/close
     stick instead of snapping back on the next keystroke — and a mode switch
     mid-edit does not slam the panel they are typing in. */
  const storageFieldsDefaultOpen = useMemo(
    () => readRecord(query.data?.byo.storage)?.kind === "byo",
    [query.data],
  );
  const quotaOverrideCount = useMemo(() => {
    const overrides = query.data?.quotas;
    if (overrides === undefined) {
      return 0;
    }
    return QUOTA_FIELDS.filter(([key]) => overrides[key] !== undefined).length;
  }, [query.data]);

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
      // The offending field lives in the connection disclosure; an error about
      // a control the operator cannot see is a dead end.
      revealDetails(storageFieldsRef);
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
  const cutoverStorageMigration = () => {
    if (cutoverTarget === null) {
      return;
    }
    storageMigrationCutoverMutation.mutate(cutoverTarget.id, {
      /* Close on settle, not on success: a failed cutover is reported by the
         page-level banner behind this overlay, so holding the dialog open would
         cover the only account of what went wrong. */
      onSettled: () => setCutoverTarget(null),
    });
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
    <section className="grid gap-4">
      {/* Shared PageHeading for an h1 at the console's standard size — this
          rendered a `text-sm` h3 with the raw tenant UUID as its subtitle,
          which read as a caption rather than a page title. The id moved to a
          footnote below: it matters when filing a support ticket, not when
          scanning the page. */}
      <PageHeading
        title="Workspace settings"
        subtitle="Feature flags, quotas, branding, and bring-your-own storage for this tenant."
      />
      <p className="text-xs text-muted-foreground">
        {orgId === null ? (
          "Tenant identifier unavailable"
        ) : (
          <>
            Tenant <code>{orgId}</code>
          </>
        )}
      </p>

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
        // Two columns, not four. The console body caps at 1280px, so
        // `2xl:grid-cols-4` produced four ~300px columns of wildly unequal
        // height — Feature flags ran off the fold while Branding ended halfway
        // up. `items-start` stops each card stretching to its row's tallest.
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <form
            aria-label="Feature flags"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
            onSubmit={(event) => {
              event.preventDefault();
              saveFeatures();
            }}
          >
            <SectionHeader icon={<ToggleLeft aria-hidden="true" />} title="Feature flags" />
            {BOOLEAN_FEATURE_FLAG_GROUPS.map((group) => (
              <fieldset className="grid gap-2" key={group.title}>
                <legend className="admin-flag-group-legend">{group.title}</legend>
                {group.keys.map((key) => (
                  <label
                    key={key}
                    className="flex min-h-8 items-center justify-between gap-3 text-sm"
                  >
                    <span>{BOOLEAN_FEATURE_FLAG_LABELS.get(key) ?? key}</span>
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
              </fieldset>
            ))}
            <div className="grid gap-2">
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
            {/* Saving with nothing dirty PATCHed an empty patch — a control
                that does nothing. The count says what the button will write. */}
            <p className="text-xs text-muted-foreground" role="status">
              {dirtyFeatureKeys.size === 0
                ? "No unsaved flag changes."
                : `${String(dirtyFeatureKeys.size)} unsaved flag change${dirtyFeatureKeys.size === 1 ? "" : "s"}.`}
            </p>
            <SaveButton
              disabled={!canSave || dirtyFeatureKeys.size === 0}
              label="Save feature flags"
              onClick={saveFeatures}
            />
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
            {/* Storage mode is the decision; everything below only matters once
                it is "Customer-owned", so it goes one level in. Seeded open
                when the tenant is already on customer-owned storage — a
                disclosure that hides a live bucket is worse than a flat list. */}
            <Disclosure
              detail={byoConnectionSummary(byoStorage)}
              detailsRef={storageFieldsRef}
              open={storageFieldsDefaultOpen}
              title="Connection details"
            >
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
            </Disclosure>
            {/* Save is the card's one primary action; Test is a check you run
                alongside it. Both rendered as filled violet buttons, which put
                three equal-weight primaries on this page once button
                backgrounds started applying at all. */}
            <div className="flex flex-wrap gap-2">
              <SaveButton disabled={!canSave} label="Save BYO storage" onClick={saveByoStorage} />
              <Button
                disabled={!canSave}
                onClick={testStorage}
                size="sm"
                type="button"
                variant="outline"
              >
                <Activity aria-hidden="true" />
                {storageTestMutation.isPending ? "Testing storage" : "Test storage"}
              </Button>
            </div>
            {storageHealth === null ? null : (
              <p className="text-xs text-muted-foreground" role="status">
                {storageHealth.status}: {storageHealth.message}
                {storageHealth.managedBy === undefined ? "" : ` (${storageHealth.managedBy})`}
                {storageHealth.prefix === undefined ? "" : ` prefix ${storageHealth.prefix}`}
              </p>
            )}
            {/* Rare and destructive: it copies every object in the tenant and
                the cutover repoints live reads. It sat permanently open under
                the save controls, giving a one-off operation the same standing
                as the fields an operator edits weekly. Closed by default, and
                re-opened by `revealDetails` the moment a job exists so an
                in-flight migration is never concealed. */}
            <Disclosure
              detail={migrationSummary(storageMigration)}
              detailsRef={migrationRef}
              open={false}
              title="Storage migration"
            >
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
                  {storageMigration.dryRun === false && storageMigration.status === "succeeded" ? (
                    /* The "Confirm migration cutover" checkbox that used to sit
                       here is gone. Consent is the dialog: a checkbox in front
                       of a typed confirmation is a gate the operator learns to
                       click past on the way to the real one, and it read as a
                       setting rather than as the point of no return. */
                    <div className="grid gap-2 border-t border-border/70 pt-2">
                      <Button
                        disabled={!canCutoverMigration}
                        onClick={() => setCutoverTarget(storageMigration)}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        <ArrowRightLeft aria-hidden="true" />
                        {storageMigrationCutoverMutation.isPending
                          ? "Cutting over"
                          : "Cut over storage"}
                      </Button>
                      {/* A dark button with no stated reason is a dead end, and
                          the counts that blocked it are printed three lines up.
                          No `role="status"` of its own: the panel around it is
                          already the live region, and nesting one inside another
                          is how announcements get dropped. */}
                      {cutoverBlocker === null ? null : (
                        <p className="text-xs text-muted-foreground">{cutoverBlocker}</p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </Disclosure>
          </form>

          {/* Read-only reference, so it sits after the editable cards and its
              rows fold away. Seeded open whenever a tenant override exists —
              an override is an active setting and must not be concealed. */}
          <section
            aria-label="Quotas"
            className="grid content-start gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
          >
            <SectionHeader icon={<Gauge aria-hidden="true" />} title="Quotas" />
            <p className="text-xs text-muted-foreground">
              {query.data?.plan === null || query.data?.plan === undefined
                ? "Effective limits are shown from system defaults and tenant overrides."
                : `${query.data.plan.displayName} plan defaults with tenant overrides applied.`}
            </p>
            <Disclosure
              detail={quotaSummary(quotaRows.length, quotaOverrideCount)}
              open={quotaOverrideCount > 0}
              title="Effective limits"
            >
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
            </Disclosure>
          </section>
        </div>
      )}

      {/* The console's top tier. Cutover is not one object: it repoints every
          live object read for the whole tenant, so it carries the blast radius
          AND a typed `confirmPhrase`. The phrase is the tenant id printed under
          the page title — the operator reads it off this page, never goes
          hunting for it, and typing it is a second look at which workspace they
          are about to move. */}
      {cutoverTarget === null || orgId === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setCutoverTarget(null);
            }
          }}
          title="Cut over tenant storage"
          blastRadius={cutoverBlastRadius(cutoverTarget, orgId)}
          confirmPhrase={orgId}
          confirmLabel="Cut over storage"
          isPending={storageMigrationCutoverMutation.isPending}
          onConfirm={cutoverStorageMigration}
        >
          Repoints every live object read and write for tenant <code>{orgId}</code> to{" "}
          {formatMigrationTarget(cutoverTarget.target)}. The backend this job copied from is
          reported as <code>{cutoverTarget.sourceStorage?.managedBy ?? "unknown"}</code>.
        </ConfirmDestructive>
      )}
    </section>
  );
}

/* Why the cutover button is dark, said where the counts that blocked it are
   already printed — a disabled control with no stated reason is a dead end.
   Null means nothing is holding it back. */
function cutoverBlockerFor(migration: TenantStorageMigrationJob): string | null {
  if (migration.lastError !== null) {
    return "The last run reported an error. Cutover stays blocked until a re-run finishes clean.";
  }
  if (migration.failures.length > 0) {
    const count = migration.failures.length;
    return `${String(count)} object${count === 1 ? "" : "s"} failed to copy. Cutover stays blocked until a re-run copies ${count === 1 ? "it" : "them"}.`;
  }
  if (
    migration.copiedCount !== migration.plannedCount ||
    migration.verifiedCount !== migration.plannedCount
  ) {
    return `Cutover needs all ${String(migration.plannedCount)} planned objects copied and verified — ${String(migration.copiedCount)} copied, ${String(migration.verifiedCount)} verified so far.`;
  }
  return null;
}

/* The numbers are the job's own, and the gate above guarantees planned, copied
   and verified agree by the time this can be read — so the count is what the
   platform verified, not an estimate of what cutover will touch. */
function cutoverBlastRadius(migration: TenantStorageMigrationJob, orgId: string): string {
  return `All ${String(migration.verifiedCount)} verified objects start serving from ${formatMigrationTarget(migration.target)} the moment this lands, for every user and every app in tenant ${orgId}. Going back means running a full migration the other way.`;
}

/** Force a disclosure open without taking control of it.
 *
 *  React writes a DOM prop only when its value changes between renders, so
 *  poking `open` here sticks: the next render still passes the same `open`
 *  value it always did and leaves the attribute alone. Used when something
 *  outside the panel — a validation failure, a migration job appearing —
 *  means the operator must see what is inside. */
function revealDetails(ref: { readonly current: HTMLDetailsElement | null }): void {
  if (ref.current !== null) {
    ref.current.open = true;
  }
}

/* A disclosure summary has to answer "what is in here" AND "is anything in
   here set" — otherwise it is just a lid on a surprise. */
function Disclosure({
  children,
  detail,
  detailsRef,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly detail: string;
  readonly detailsRef?: Ref<HTMLDetailsElement>;
  readonly open: boolean;
  readonly title: string;
}) {
  return (
    <details className="group rounded-md border border-border/70" open={open} ref={detailsRef}>
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        {/* h3 under the card's h2 — the level the outline expects here, and the
            one element type a <summary> may hold besides phrasing content. */}
        <h3 className="grid gap-0.5 text-sm font-semibold">
          {title}
          <span className="font-normal text-muted-foreground">{detail}</span>
        </h3>
      </summary>
      <div className="grid gap-2 border-t border-border/70 px-3 py-3">{children}</div>
    </details>
  );
}

/* h2, not h4: these card titles sit directly under the page's single h1 from
   `PageHeading`, and this is the only sub-heading level in the file — an h4
   here skipped two levels on every render. The visual size stays put; only the
   outline level changes. */
function SectionHeader({ icon, title }: { readonly icon: ReactNode; readonly title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold">
      <span className="[&_svg]:size-4">{icon}</span>
      {title}
    </h2>
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

/* The tenant-config contract types every quota as `number | null`, where null
   is a real "no cap". Anything else means the API did not report that key —
   which is a different claim, and rendering it as "unlimited" told an operator
   a limit was lifted when we simply do not know. */
function formatQuotaValue(value: unknown): string {
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US").format(value);
  }
  return value === null ? "Unlimited" : "Not reported";
}

function quotaSummary(limitCount: number, overrideCount: number): string {
  const overrides =
    overrideCount === 0
      ? "no tenant overrides"
      : `${String(overrideCount)} tenant override${overrideCount === 1 ? "" : "s"}`;
  return `Read-only · ${String(limitCount)} limits · ${overrides}`;
}

function byoConnectionSummary(state: ByoStorageState): string {
  if (state.kind === "helix-default") {
    return "Helix manages the bucket — only the object prefix applies.";
  }
  const provider =
    BYO_STORAGE_PROVIDERS.find(([value]) => value === state.provider)?.[1] ?? state.provider;
  const bucket = state.bucket.trim();
  return `${provider} · ${bucket.length === 0 ? "no bucket set" : bucket}`;
}

function migrationSummary(migration: TenantStorageMigrationJob | null): string {
  if (migration === null) {
    return "Copies every object to another backend. Dry run first — cutover repoints live reads.";
  }
  return `${formatMigrationStatus(migration.status)} · ${
    migration.dryRun ? "dry run" : "live migration"
  } to ${formatMigrationTarget(migration.target)}`;
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

function brandingPlaceholder(key: BrandingKey): string | undefined {
  if (key === "accent_color_hex") {
    return "#2f6fed";
  }
  if (key === "logo_url") {
    return "https://example.com/logo.png";
  }
  return undefined;
}

function byoStoragePlaceholder(
  key: ByoStorageFieldKey,
  provider: ByoStorageProvider,
): string | undefined {
  if (key === "endpoint") {
    return provider === "aws-s3"
      ? "https://s3.amazonaws.com"
      : "https://account.r2.cloudflarestorage.com";
  }
  if (key === "region") {
    return "us-east-1";
  }
  if (key === "bucket") {
    return "acme-helix-data";
  }
  if (key === "prefix") {
    return "helix/";
  }
  if (key === "credentials_vault_path") {
    return "tenants/acme/byo-storage/s3";
  }
  if (key === "sse_kms_key_arn") {
    return "arn:aws:kms:us-east-1:123456789012:key/...";
  }
  return undefined;
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
