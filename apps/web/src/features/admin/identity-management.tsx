import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  EmptyRow,
  EmptyState,
  PageHeading,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import {
  adminIdentityQueryKeys,
  adminIdentityQueryOptions,
  createTenantIdpConfig,
  deleteTenantIdpConfig,
  promoteTenantIdpConfig,
  testTenantIdpConfigLogin,
  updateTenantIdpConfig,
  type AdminIdentityTestLogin,
  type TenantIdpConfig,
  type TenantIdpProtocol,
  type UpdateTenantIdpConfigInput,
} from "./identity-api";

/* There is no shared Select or Textarea primitive, so both restate the shell
   `components/ui/input` draws rather than growing a second field look. */
const SELECT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";
const TEXTAREA_CLASS =
  "min-h-[76px] w-full min-w-0 resize-y rounded-md border border-outline bg-surface-container px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

const FIELD_LABEL_CLASS = "grid gap-1 text-xs text-muted-foreground";
const CHECKBOX_LABEL_CLASS = "flex min-h-8 items-center gap-2 text-sm";

/* auto-fit rather than a fixed column count: switching protocol swaps one SAML
   field for two OIDC fields, and a fixed grid leaves a hole behind. */
const FIELD_GRID_CLASS = "grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]";

/* Structural rather than importing `QueryClient`: the route loader only ever
   hands this helper an `ensureQueryData`, and typing it that way keeps the
   section free of a router/query-client dependency it does not otherwise have. */
interface AdminIdentityRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminIdentityQueryOptions>): Promise<unknown>;
}

/** Warms the exact key `IdentityManagement` mounts, so the section's first
 *  request leaves while its chunk is still downloading. Failures are swallowed:
 *  the mounted `useQuery` re-reports them through `QueryFailureBanner`, and a
 *  rejected loader would blank the route over a fetch the page can recover. */
export async function prefetchAdminIdentityQuery(queryClient: AdminIdentityRouteQueryClient) {
  await queryClient.ensureQueryData(adminIdentityQueryOptions()).catch(() => undefined);
}

export function IdentityManagement() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery(adminIdentityQueryOptions());
  const identityFailure = useQueryFailure(identityQuery, () => {
    void queryClient.invalidateQueries({ queryKey: adminIdentityQueryKeys.detail() });
  });
  const [form, setForm] = useState<IdpFormState>(() => emptyIdpForm());
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testLogin, setTestLogin] = useState<AdminIdentityTestLogin | null>(null);
  const [configToDelete, setConfigToDelete] = useState<TenantIdpConfig | null>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  /* The drawer stays uncontrolled: a React-owned `open` prop only writes to the
     DOM when its value changes, so a disclosure the operator opened by hand can
     be reopened-that-does-nothing on the next render. The browser owns the
     toggle; we only ever force it open. */
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const mappingEditorRows = useMemo(
    () => attributeMappingEditorRows(form.attrMappingJson),
    [form.attrMappingJson],
  );
  const mappingPreview = useMemo(
    () => previewAttributeMapping(form.attrMappingJson, form.sampleClaimsJson),
    [form.attrMappingJson, form.sampleClaimsJson],
  );

  const createMutation = useMutation({
    mutationFn: () => {
      const input = buildCreateInput(form);
      return createTenantIdpConfig(input);
    },
    onMutate: () => {
      setFormError(null);
    },
    onError: (mutationError: unknown) => {
      setFormError(mutationError instanceof Error ? mutationError.message : "Failed to add IdP.");
    },
    onSuccess: () => {
      setForm(emptyIdpForm());
      void queryClient.invalidateQueries({ queryKey: adminIdentityQueryKeys.detail() });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (id: string) => promoteTenantIdpConfig(id),
    onMutate: () => {
      setFormError(null);
    },
    onError: (mutationError: unknown) => {
      setFormError(
        mutationError instanceof Error ? mutationError.message : "Failed to promote IdP.",
      );
    },
    onSuccess: () => {
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: adminIdentityQueryKeys.detail() });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { readonly id: string; readonly patch: UpdateTenantIdpConfigInput }) => {
      return updateTenantIdpConfig(input.id, input.patch);
    },
    onMutate: () => {
      setFormError(null);
    },
    onError: (mutationError: unknown) => {
      setFormError(
        mutationError instanceof Error ? mutationError.message : "Failed to update IdP.",
      );
    },
    onSuccess: () => {
      setEditingConfigId(null);
      setForm(emptyIdpForm());
      void queryClient.invalidateQueries({ queryKey: adminIdentityQueryKeys.detail() });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTenantIdpConfig(id),
    onMutate: () => {
      setFormError(null);
    },
    onError: (mutationError: unknown) => {
      setFormError(
        mutationError instanceof Error ? mutationError.message : "Failed to delete IdP.",
      );
    },
    onSuccess: () => {
      setConfigToDelete(null);
      void queryClient.invalidateQueries({ queryKey: adminIdentityQueryKeys.detail() });
    },
  });

  const testLoginMutation = useMutation({
    mutationFn: (id: string) => testTenantIdpConfigLogin(id),
    onMutate: () => {
      setFormError(null);
      setTestLogin(null);
    },
    onError: (mutationError: unknown) => {
      setFormError(
        mutationError instanceof Error ? mutationError.message : "Failed to check IdP login.",
      );
    },
    onSuccess: (result) => {
      setTestLogin(result);
    },
  });

  const idpConfigs = identityQuery.data?.idpConfigs ?? [];
  const sortedConfigs = useMemo(
    () =>
      [...idpConfigs].sort((left, right) => {
        if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      }),
    [idpConfigs],
  );

  function startNewIdp() {
    setEditingConfigId(null);
    setFormError(null);
    setForm(emptyIdpForm());
    displayNameRef.current?.focus();
  }

  /* The one form does both jobs, so the submit button has to say which one it
     is about to do — and, while a request is in flight, that it is doing it. */
  let submitLabel: string;
  if (editingConfigId !== null) {
    submitLabel = updateMutation.isPending ? "Saving..." : "Save IdP";
  } else if (createMutation.isPending) {
    submitLabel = "Adding...";
  } else {
    submitLabel = "Add IdP";
  }

  return (
    <>
      <PageHeading
        title="Identity & SSO"
        subtitle="Local recovery, tenant IdPs, and provisioning entry points"
      />

      {identityQuery.isPending && identityFailure === null ? (
        <StateBanner kind="loading">Loading identity settings…</StateBanner>
      ) : null}
      {identityFailure === null ? null : (
        /* Outline, not default: the add/edit form below stays usable while the
           list is unreadable, and two competing primary buttons would hide
           which one submits the form. */
        <QueryFailureBanner
          summary="Identity settings could not be loaded."
          subject="identity settings"
          error={identityFailure.error}
          isRetrying={identityFailure.isRetrying}
          onRetry={identityFailure.retry}
          retryVariant="outline"
        >
          The tenant IdP list and the local recovery state are unknown until this loads.
        </QueryFailureBanner>
      )}
      {formError === null ? null : <StateBanner kind="error">{formError}</StateBanner>}
      {testLogin === null ? null : (
        <StateBanner kind={testLogin.status === "runtime_pending" ? "info" : "error"}>
          {testLogin.message}
        </StateBanner>
      )}

      <div className="col gap-4">
        <section className="panel p-4" aria-labelledby="identity-local-login">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"
            >
              <Icons.Key />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="identity-local-login" className="text-sm font-semibold">
                Local email/password login
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">Owner/admin recovery path</p>
            </div>
            {/* The platform pins this path on — the API models it as a literal
                `true`, so there is no off state to render. Until the request
                lands there is also nothing to claim, hence no chip. */}
            {identityQuery.data === undefined ? null : (
              <span className="chip success">
                <span className="chip-dot" />
                enabled
              </span>
            )}
          </div>
        </section>

        <section className="panel p-4" aria-labelledby="identity-tenant-idps">
          <div className="mb-3 flex items-center gap-2">
            <Icons.Shield />
            <h2 id="identity-tenant-idps" className="text-sm font-semibold">
              Tenant IdPs
            </h2>
            {/* A count of 0 is a claim. Nothing was counted until the list
                arrives, so nothing is shown. */}
            {identityQuery.data === undefined ? null : (
              <span className="text-xs text-muted-foreground">{sortedConfigs.length}</span>
            )}
          </div>

          {identityQuery.isPending ? (
            <EmptyRow>Loading tenant IdPs…</EmptyRow>
          ) : identityQuery.data === undefined ? (
            <EmptyRow>Tenant IdPs could not be loaded.</EmptyRow>
          ) : sortedConfigs.length === 0 ? (
            <EmptyState
              icon={<Icons.Shield />}
              title="No identity providers"
              /* Outline: the add form is already open below and owns the page's
                 one primary button. This jumps to it, it does not replace it. */
              action={
                <Button type="button" variant="outline" onClick={startNewIdp}>
                  <Icons.Plus />
                  Add your first IdP
                </Button>
              }
            >
              A tenant IdP lets this workspace sign in through SAML or OIDC. Local email/password
              recovery stays available for owners and admins either way.
            </EmptyState>
          ) : (
            <div className="col gap-2">
              {sortedConfigs.map((config) => (
                <IdpConfigRow
                  key={config.id}
                  config={config}
                  promotePending={promoteMutation.isPending}
                  onPromote={() => promoteMutation.mutate(config.id)}
                  updatePending={updateMutation.isPending}
                  onToggleEnabled={() =>
                    updateMutation.mutate({ id: config.id, patch: { enabled: !config.enabled } })
                  }
                  onToggleJit={() =>
                    updateMutation.mutate({
                      id: config.id,
                      patch: { jitProvisioning: !config.jitProvisioning },
                    })
                  }
                  onEdit={() => {
                    setFormError(null);
                    setEditingConfigId(config.id);
                    setForm(formFromConfig(config));
                    /* Editing is the one time the stored claim mapping matters:
                       open the drawer so it is not silently carried over. */
                    if (advancedRef.current !== null) {
                      advancedRef.current.open = true;
                    }
                  }}
                  deletePending={deleteMutation.isPending}
                  onDelete={() => setConfigToDelete(config)}
                  testPending={testLoginMutation.isPending}
                  onTestLogin={() => testLoginMutation.mutate(config.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel p-4" aria-labelledby="identity-idp-form">
          <div className="mb-3 flex items-center gap-2">
            {editingConfigId === null ? <Icons.Plus /> : <Icons.EditPen />}
            <h2 id="identity-idp-form" className="text-sm font-semibold">
              {editingConfigId === null ? "Add IdP" : "Edit IdP"}
            </h2>
          </div>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setFormError(null);
              const configId = editingConfigId;
              /* Built here rather than only inside the mutation so a validation
                 failure lands in the form's own error banner instead of the
                 mutation's, which reports transport failures. */
              let patch: ReturnType<typeof buildUpdateInput>;
              try {
                patch = configId === null ? buildCreateInput(form) : buildUpdateInput(form);
              } catch (error) {
                setFormError(error instanceof Error ? error.message : String(error));
                return;
              }
              if (configId === null) {
                createMutation.mutate();
              } else {
                updateMutation.mutate({ id: configId, patch });
              }
            }}
          >
            <div className={FIELD_GRID_CLASS}>
              <label className={FIELD_LABEL_CLASS}>
                <span>Protocol</span>
                <select
                  aria-label="IdP protocol"
                  value={form.protocol}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      protocol: event.target.value as TenantIdpProtocol,
                    }))
                  }
                  className={SELECT_CLASS}
                >
                  <option value="saml">SAML</option>
                  <option value="oidc">OIDC</option>
                </select>
              </label>
              <label className={FIELD_LABEL_CLASS}>
                <span>Display name</span>
                <Input
                  ref={displayNameRef}
                  aria-label="IdP display name"
                  value={form.displayName}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                />
              </label>
              {form.protocol === "saml" ? (
                <label className={FIELD_LABEL_CLASS}>
                  <span>Metadata URL</span>
                  <Input
                    aria-label="SAML metadata URL"
                    value={form.metadataUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, metadataUrl: event.target.value }))
                    }
                  />
                </label>
              ) : (
                <>
                  <label className={FIELD_LABEL_CLASS}>
                    <span>Issuer URL</span>
                    <Input
                      aria-label="OIDC issuer URL"
                      value={form.issuer}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, issuer: event.target.value }))
                      }
                    />
                  </label>
                  <label className={FIELD_LABEL_CLASS}>
                    <span>Client ID</span>
                    <Input
                      aria-label="OIDC client ID"
                      value={form.clientId}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, clientId: event.target.value }))
                      }
                    />
                  </label>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  className="size-4"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                Enabled
              </label>
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  className="size-4"
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, isPrimary: event.target.checked }))
                  }
                />
                Primary
              </label>
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  className="size-4"
                  type="checkbox"
                  checked={form.jitProvisioning}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, jitProvisioning: event.target.checked }))
                  }
                />
                JIT provisioning
              </label>
            </div>

            <details
              ref={advancedRef}
              className="rounded-md border border-border bg-muted/40 px-3 py-2"
            >
              <summary className="cursor-pointer rounded-sm text-xs font-semibold marker:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none">
                Advanced provider settings
                <span className="ml-2 font-normal text-muted-foreground">
                  Signing certificate path, claim mappings, and a preview against sample claims
                </span>
              </summary>
              <div className="mt-3 grid gap-3">
                <label className={FIELD_LABEL_CLASS}>
                  <span>Signing cert Vault path</span>
                  <Input
                    aria-label="Signing cert Vault path"
                    value={form.signingCertVaultPath}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        signingCertVaultPath: event.target.value,
                      }))
                    }
                    placeholder="tenants/<org>/idp/saml-signing-cert"
                  />
                </label>

                {/* Frame spelled out rather than `.panel`: that class is
                    unlayered, so it outranks every Tailwind background and a
                    nested panel silently stays white-on-white. */}
                <div
                  aria-label="Attribute mapping editor"
                  className={`rounded-md border border-border bg-muted p-3 ${FIELD_GRID_CLASS}`}
                >
                  {mappingEditorRows.map((row) => (
                    <label key={row.attribute} className={FIELD_LABEL_CLASS}>
                      <span>{row.label}</span>
                      <Input
                        aria-label={`${row.label} claim selector`}
                        value={row.selector}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            attrMappingJson: updateAttributeMappingJson(
                              current.attrMappingJson,
                              row.attribute,
                              event.target.value,
                            ),
                          }))
                        }
                        placeholder={row.placeholder}
                      />
                    </label>
                  ))}
                </div>

                <label className={FIELD_LABEL_CLASS}>
                  <span>Attribute mapping JSON</span>
                  <textarea
                    aria-label="Attribute mapping JSON"
                    className={`mono ${TEXTAREA_CLASS}`}
                    value={form.attrMappingJson}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, attrMappingJson: event.target.value }))
                    }
                  />
                </label>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <label className={FIELD_LABEL_CLASS}>
                    <span>Sample claims JSON</span>
                    <textarea
                      aria-label="Sample claims JSON"
                      className={`mono ${TEXTAREA_CLASS}`}
                      value={form.sampleClaimsJson}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, sampleClaimsJson: event.target.value }))
                      }
                    />
                  </label>
                  <div
                    aria-label="Attribute mapping preview"
                    className="min-h-[76px] rounded-md border border-border bg-muted p-3 text-xs"
                  >
                    {/* h3, one step below the panel's h2: the preview is a region
                        of the form, not a page-level panel of its own. */}
                    <h3 className="mb-2 font-semibold text-foreground">Mapping preview</h3>
                    {mappingPreview.status === "error" ? (
                      <StateBanner kind="error">{mappingPreview.message}</StateBanner>
                    ) : mappingPreview.rows.length === 0 ? (
                      <EmptyRow>No mapped attributes.</EmptyRow>
                    ) : (
                      <dl className="grid gap-1.5">
                        {mappingPreview.rows.map((row) => (
                          <div
                            key={row.attribute}
                            className="grid grid-cols-[minmax(80px,0.45fr)_minmax(0,1fr)] items-baseline gap-2"
                          >
                            <dt className="font-semibold">{row.attribute}</dt>
                            <dd
                              className={row.value === null ? "text-muted-foreground" : undefined}
                            >
                              {row.value ?? "not found"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </div>
              </div>
            </details>

            <div className="flex flex-wrap justify-end gap-2">
              {editingConfigId === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={updateMutation.isPending}
                  onClick={() => {
                    setEditingConfigId(null);
                    setFormError(null);
                    setForm(emptyIdpForm());
                  }}
                >
                  Cancel edit
                </Button>
              )}
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editingConfigId === null ? <Icons.Plus /> : <Icons.EditPen />}
                {submitLabel}
              </Button>
            </div>
          </form>
        </section>
      </div>

      {/* The shared confirmation, not a private rebuild of the AlertDialog
          stack: the destructive-action policy lives in that one component, and
          a hand-rolled copy drifts out of it without anything failing.

          Tier: irreversible and it reaches well past the row — deleting cuts
          SSO for everyone who signs in through this provider — so it carries a
          `blastRadius` counted off the loaded config list. It stops short of
          `confirmPhrase`: the Add IdP form on this same page can rebuild the
          entry, so recovery is not a support ticket. */}
      {configToDelete === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfigToDelete(null);
            }
          }}
          title="Delete tenant IdP"
          blastRadius={idpDeletionBlastRadius(configToDelete, idpConfigs)}
          confirmLabel="Delete IdP"
          isPending={deleteMutation.isPending}
          onConfirm={() => {
            deleteMutation.mutate(configToDelete.id);
          }}
        >
          Deletes <strong>{configToDelete.displayName}</strong> (
          {configToDelete.protocol.toUpperCase()}) from this tenant, with its claim mapping and
          connection settings. Re-adding it means entering that configuration again from the
          provider — this console holds no copy of the provider&rsquo;s client secret. Local
          email/password recovery stays enabled for owner/admin access.
        </ConfirmDestructive>
      )}
    </>
  );
}

/* Counted off the loaded list rather than asserted: "SSO will break" is a
   warning an operator already assumed, "no other enabled provider is left" is
   the thing that decides whether they click. */
function idpDeletionBlastRadius(
  target: TenantIdpConfig,
  configs: readonly TenantIdpConfig[],
): string {
  const otherEnabled = configs.filter((config) => config.id !== target.id && config.enabled).length;
  const impact = target.enabled
    ? `Every user who signs in through ${target.displayName} loses SSO immediately${
        target.isPrimary ? ", and it is this tenant's primary provider" : ""
      }.`
    : `${target.displayName} is disabled, so no one is signing in through it right now.`;
  const remaining =
    otherEnabled === 0
      ? "No other enabled provider is left — owner/admin email/password recovery becomes the only way in."
      : `${String(otherEnabled)} other enabled provider${
          otherEnabled === 1 ? " remains" : "s remain"
        } for them to sign in through.`;
  return `${impact} ${remaining}`;
}

function IdpConfigRow({
  config,
  promotePending,
  onPromote,
  updatePending,
  onToggleEnabled,
  onToggleJit,
  onEdit,
  deletePending,
  onDelete,
  testPending,
  onTestLogin,
}: {
  readonly config: TenantIdpConfig;
  readonly promotePending: boolean;
  readonly onPromote: () => void;
  readonly updatePending: boolean;
  readonly onToggleEnabled: () => void;
  readonly onToggleJit: () => void;
  readonly onEdit: () => void;
  readonly deletePending: boolean;
  readonly onDelete: () => void;
  readonly testPending: boolean;
  readonly onTestLogin: () => void;
}) {
  return (
    <div className="panel flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{config.displayName}</span>
          <span className={`chip ${config.enabled ? "success" : "warning"}`}>
            <span className="chip-dot" />
            {config.enabled ? "enabled" : "disabled"}
          </span>
          {config.isPrimary ? (
            <span className="chip success">
              <span className="chip-dot" />
              primary
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {config.protocol.toUpperCase()} | {config.signingCertVaultPath ?? "no signing cert path"}
        </p>
      </div>
      {/* No primary button in the row: the decision a row carries is which
          provider is on, and the chips already say that. */}
      <div className="flex flex-wrap items-center gap-2">
        {config.samlSpMetadataUrl === null ? null : (
          <Button asChild size="sm" variant="outline">
            <a href={config.samlSpMetadataUrl} download={metadataDownloadName(config)}>
              <Icons.Download />
              Metadata
            </a>
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={testPending}
          onClick={onTestLogin}
        >
          Test login
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={promotePending || config.isPrimary || !config.enabled}
          title={promoteBlockedReason(config)}
          onClick={onPromote}
        >
          Make primary
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={updatePending}
          onClick={onToggleEnabled}
        >
          {config.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={updatePending}
          onClick={onToggleJit}
        >
          {config.jitProvisioning ? "Disable JIT" : "Enable JIT"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={updatePending} onClick={onEdit}>
          <Icons.EditPen />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={deletePending}
          onClick={onDelete}
        >
          <Icons.Trash />
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Why "Make primary" is unavailable, so the disabled control is not a dead
 *  end the operator has to guess at. */
function promoteBlockedReason(config: TenantIdpConfig): string | undefined {
  if (config.isPrimary) {
    return "Already the primary IdP for this tenant.";
  }
  if (!config.enabled) {
    return "Enable this IdP before making it primary.";
  }
  return undefined;
}

function metadataDownloadName(config: TenantIdpConfig): string {
  return `${
    config.displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "tenant"
  }-sp-metadata.xml`;
}

interface IdpFormState {
  readonly protocol: TenantIdpProtocol;
  readonly displayName: string;
  readonly metadataUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly signingCertVaultPath: string;
  readonly attrMappingJson: string;
  readonly sampleClaimsJson: string;
  readonly isPrimary: boolean;
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
}

function emptyIdpForm(): IdpFormState {
  return {
    protocol: "saml",
    displayName: "",
    metadataUrl: "",
    issuer: "",
    clientId: "",
    signingCertVaultPath: "",
    attrMappingJson: '{\n  "email": "$.email",\n  "displayName": "$.name"\n}',
    sampleClaimsJson: '{\n  "email": "alice@example.com",\n  "name": "Alice Example"\n}',
    isPrimary: false,
    jitProvisioning: true,
    enabled: true,
  };
}

function formFromConfig(config: TenantIdpConfig): IdpFormState {
  return {
    protocol: config.protocol,
    displayName: config.displayName,
    metadataUrl: stringField(config.config, "metadataUrl"),
    issuer: stringField(config.config, "issuer"),
    clientId: stringField(config.config, "clientId"),
    signingCertVaultPath: config.signingCertVaultPath ?? "",
    attrMappingJson: JSON.stringify(config.attrMapping, null, 2),
    sampleClaimsJson: emptyIdpForm().sampleClaimsJson,
    isPrimary: config.isPrimary,
    jitProvisioning: config.jitProvisioning,
    enabled: config.enabled,
  };
}

function buildCreateInput(form: IdpFormState) {
  if (form.displayName.trim().length === 0) {
    throw new Error("Display name is required.");
  }
  const attrMapping = parseJsonObject(form.attrMappingJson, "Attribute mapping JSON");
  const config =
    form.protocol === "saml"
      ? compactObject({ metadataUrl: form.metadataUrl.trim() })
      : compactObject({ issuer: form.issuer.trim(), clientId: form.clientId.trim() });
  return {
    protocol: form.protocol,
    displayName: form.displayName.trim(),
    config,
    attrMapping,
    signingCertVaultPath:
      form.signingCertVaultPath.trim().length === 0 ? null : form.signingCertVaultPath.trim(),
    enabled: form.enabled,
    isPrimary: form.isPrimary,
    jitProvisioning: form.jitProvisioning,
  };
}

/* A full replacement, so the update payload is exactly the create payload —
   every field the create form validates is sent again. */
function buildUpdateInput(form: IdpFormState): ReturnType<typeof buildCreateInput> {
  return buildCreateInput(form);
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the consistent validation message below.
  }
  throw new Error(`${label} must be a JSON object.`);
}

function compactObject(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry.length > 0));
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

type MappingPreview =
  | {
      readonly status: "ready";
      readonly rows: readonly { readonly attribute: string; readonly value: string | null }[];
    }
  | { readonly status: "error"; readonly message: string };

const ATTRIBUTE_MAPPING_FIELDS = [
  { attribute: "email", label: "Email", placeholder: "$.email" },
  { attribute: "displayName", label: "Display name", placeholder: "$.name" },
  { attribute: "givenName", label: "Given name", placeholder: "$.given_name" },
  { attribute: "familyName", label: "Family name", placeholder: "$.family_name" },
  { attribute: "groups", label: "Groups", placeholder: "$.groups" },
  { attribute: "externalId", label: "External ID", placeholder: "$.sub" },
] as const;

function attributeMappingEditorRows(mappingJson: string) {
  const mapping = safeParseJsonObject(mappingJson);
  return ATTRIBUTE_MAPPING_FIELDS.map((field) => ({
    ...field,
    selector: stringField(mapping ?? {}, field.attribute),
  }));
}

function updateAttributeMappingJson(
  mappingJson: string,
  attribute: string,
  selector: string,
): string {
  const mapping = safeParseJsonObject(mappingJson) ?? {};
  const nextSelector = selector.trim();
  if (nextSelector.length === 0) {
    delete mapping[attribute];
  } else {
    mapping[attribute] = nextSelector;
  }
  return JSON.stringify(mapping, null, 2);
}

function previewAttributeMapping(mappingJson: string, claimsJson: string): MappingPreview {
  let mapping: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    mapping = parseJsonObject(mappingJson, "Attribute mapping JSON");
  } catch {
    return { status: "error", message: "Attribute mapping JSON must be a JSON object." };
  }
  try {
    claims = parseJsonObject(claimsJson, "Sample claims JSON");
  } catch {
    return { status: "error", message: "Sample claims JSON must be a JSON object." };
  }
  return {
    status: "ready",
    rows: Object.entries(mapping).map(([attribute, selector]) => ({
      attribute,
      value: typeof selector === "string" ? stringValueAtSelector(claims, selector) : null,
    })),
  };
}

function safeParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON remains visible in the advanced editor and preview error.
  }
  return null;
}

function stringValueAtSelector(claims: Record<string, unknown>, selector: string): string | null {
  const path = selector.trim();
  if (!path.startsWith("$.")) {
    return null;
  }
  let value: unknown = claims;
  for (const segment of path.slice(2).split(".")) {
    if (
      segment.length === 0 ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return null;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
