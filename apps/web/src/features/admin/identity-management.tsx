import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

const FIELD_STYLE: React.CSSProperties = {
  height: 32,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  padding: "0 8px",
  fontSize: "var(--text-meta)",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  minHeight: 76,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  padding: 8,
  fontSize: "var(--text-meta)",
  resize: "vertical",
  fontFamily: "var(--font-mono, monospace)",
};

function Banner({ kind, children }: { kind: "loading" | "error" | "info"; children: string }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        fontSize: "var(--text-meta)",
        marginBottom: 12,
        background: kind === "error" ? "var(--danger-soft, var(--surface-2))" : "var(--surface-2)",
        color: kind === "error" ? "var(--danger)" : "var(--text-2)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

export function IdentityManagement() {
  const queryClient = useQueryClient();
  const identityQuery = useQuery(adminIdentityQueryOptions());
  const [form, setForm] = useState<IdpFormState>(() => emptyIdpForm());
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testLogin, setTestLogin] = useState<AdminIdentityTestLogin | null>(null);
  const [configToDelete, setConfigToDelete] = useState<TenantIdpConfig | null>(null);
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

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: "var(--text-h2)", fontWeight: 600, margin: 0 }}>Identity</h1>
        <div style={{ fontSize: "var(--text-body-sm)", color: "var(--text-3)", marginTop: 4 }}>
          Local recovery, tenant IdPs, and provisioning entry points
        </div>
      </div>

      {identityQuery.isPending ? (
        <Banner kind="loading">Loading identity settings...</Banner>
      ) : null}
      {identityQuery.isError ? (
        <Banner kind="error">Identity settings unavailable. Try again later.</Banner>
      ) : null}
      {formError === null ? null : <Banner kind="error">{formError}</Banner>}
      {testLogin === null ? null : (
        <Banner kind={testLogin.status === "runtime_pending" ? "info" : "error"}>
          {testLogin.message}
        </Banner>
      )}

      <section className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              color: "var(--accent)",
              background: "var(--accent-soft)",
              flexShrink: 0,
            }}
          >
            <Icons.Key />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
              Local email/password login
            </div>
            <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginTop: 4 }}>
              Owner/admin recovery path
            </div>
          </div>
          <span className="chip success">
            <span className="chip-dot" />
            {identityQuery.data?.localLoginRecovery.enabled === true ? "enabled" : "enabled"}
          </span>
        </div>
      </section>

      <section className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Icons.Shield />
          <h2 style={{ fontSize: "var(--text-body)", fontWeight: 600, margin: 0 }}>Tenant IdPs</h2>
          <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
            {sortedConfigs.length}
          </span>
        </div>

        {sortedConfigs.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-3)" }}>
            No IdPs configured.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
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

      <section className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          {editingConfigId === null ? <Icons.Plus /> : <Icons.EditPen />}
          <h2 style={{ fontSize: "var(--text-body)", fontWeight: 600, margin: 0 }}>
            {editingConfigId === null ? "Add IdP" : "Edit IdP"}
          </h2>
        </div>
        <form
          style={{ display: "grid", gap: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            const configId = editingConfigId;
            try {
              if (configId === null) {
                buildCreateInput(form);
              } else {
                buildUpdateInput(form);
              }
            } catch (error) {
              setFormError(error instanceof Error ? error.message : String(error));
              return;
            }
            if (configId === null) {
              createMutation.mutate();
            } else {
              updateMutation.mutate({ id: configId, patch: buildUpdateInput(form) });
            }
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <label style={labelStyle}>
              Protocol
              <select
                aria-label="IdP protocol"
                value={form.protocol}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    protocol: event.target.value as TenantIdpProtocol,
                  }))
                }
                style={FIELD_STYLE}
              >
                <option value="saml">SAML</option>
                <option value="oidc">OIDC</option>
              </select>
            </label>
            <label style={labelStyle}>
              Display name
              <input
                aria-label="IdP display name"
                value={form.displayName}
                onChange={(event) =>
                  setForm((current) => ({ ...current, displayName: event.target.value }))
                }
                style={FIELD_STYLE}
              />
            </label>
            {form.protocol === "saml" ? (
              <label style={labelStyle}>
                Metadata URL
                <input
                  aria-label="SAML metadata URL"
                  value={form.metadataUrl}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, metadataUrl: event.target.value }))
                  }
                  style={FIELD_STYLE}
                />
              </label>
            ) : (
              <>
                <label style={labelStyle}>
                  Issuer URL
                  <input
                    aria-label="OIDC issuer URL"
                    value={form.issuer}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, issuer: event.target.value }))
                    }
                    style={FIELD_STYLE}
                  />
                </label>
                <label style={labelStyle}>
                  Client ID
                  <input
                    aria-label="OIDC client ID"
                    value={form.clientId}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, clientId: event.target.value }))
                    }
                    style={FIELD_STYLE}
                  />
                </label>
              </>
            )}
            <label style={labelStyle}>
              Signing cert Vault path
              <input
                aria-label="Signing cert Vault path"
                value={form.signingCertVaultPath}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    signingCertVaultPath: event.target.value,
                  }))
                }
                style={FIELD_STYLE}
              />
            </label>
          </div>

          <div aria-label="Attribute mapping editor" style={MAPPING_EDITOR_STYLE}>
            {mappingEditorRows.map((row) => (
              <label key={row.attribute} style={labelStyle}>
                {row.label}
                <input
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
                  style={FIELD_STYLE}
                  placeholder={row.placeholder}
                />
              </label>
            ))}
          </div>

          <label style={labelStyle}>
            Attribute mapping JSON
            <textarea
              aria-label="Attribute mapping JSON"
              value={form.attrMappingJson}
              onChange={(event) =>
                setForm((current) => ({ ...current, attrMappingJson: event.target.value }))
              }
              style={TEXTAREA_STYLE}
            />
          </label>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 12,
            }}
          >
            <label style={labelStyle}>
              Sample claims JSON
              <textarea
                aria-label="Sample claims JSON"
                value={form.sampleClaimsJson}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sampleClaimsJson: event.target.value }))
                }
                style={TEXTAREA_STYLE}
              />
            </label>
            <div aria-label="Attribute mapping preview" style={MAPPING_PREVIEW_STYLE}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Mapping preview</div>
              {mappingPreview.status === "error" ? (
                <div role="alert" style={{ color: "var(--danger)" }}>
                  {mappingPreview.message}
                </div>
              ) : mappingPreview.rows.length === 0 ? (
                <div style={{ color: "var(--text-3)" }}>No mapped attributes.</div>
              ) : (
                <dl style={MAPPING_PREVIEW_LIST_STYLE}>
                  {mappingPreview.rows.map((row) => (
                    <div key={row.attribute} style={MAPPING_PREVIEW_ROW_STYLE}>
                      <dt style={{ fontWeight: 600 }}>{row.attribute}</dt>
                      <dd style={{ margin: 0, color: row.value === null ? "var(--text-3)" : "" }}>
                        {row.value ?? "not found"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              Enabled
            </label>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={form.isPrimary}
                onChange={(event) =>
                  setForm((current) => ({ ...current, isPrimary: event.target.checked }))
                }
              />
              Primary
            </label>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={form.jitProvisioning}
                onChange={(event) =>
                  setForm((current) => ({ ...current, jitProvisioning: event.target.checked }))
                }
              />
              JIT provisioning
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {editingConfigId === null ? null : (
              <button
                type="button"
                className="btn"
                disabled={updateMutation.isPending}
                onClick={() => {
                  setEditingConfigId(null);
                  setFormError(null);
                  setForm(emptyIdpForm());
                }}
              >
                Cancel edit
              </button>
            )}
            <button
              type="submit"
              className="btn primary"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {editingConfigId === null ? <Icons.Plus /> : <Icons.EditPen />}
              {editingConfigId === null
                ? createMutation.isPending
                  ? "Adding..."
                  : "Add IdP"
                : updateMutation.isPending
                  ? "Saving..."
                  : "Save IdP"}
            </button>
          </div>
        </form>
      </section>

      <AlertDialog
        open={configToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfigToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Icons.Trash />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete tenant IdP</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {configToDelete?.displayName ?? "this IdP"} from this tenant. Local
              email/password recovery remains enabled for owner/admin access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={configToDelete === null || deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (configToDelete !== null) {
                  deleteMutation.mutate(configToDelete.id);
                }
              }}
              variant="destructive"
            >
              Delete IdP
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto auto auto auto auto auto",
        gap: 12,
        alignItems: "center",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>{config.displayName}</span>
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
        <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", marginTop: 4 }}>
          {config.protocol.toUpperCase()} | {config.signingCertVaultPath ?? "no signing cert path"}
        </div>
      </div>
      {config.samlSpMetadataUrl === null ? null : (
        <a
          className="btn sm"
          href={config.samlSpMetadataUrl}
          download={metadataDownloadName(config)}
        >
          <Icons.Download />
          Metadata
        </a>
      )}
      <button type="button" className="btn sm" disabled={testPending} onClick={onTestLogin}>
        Test login
      </button>
      <button
        type="button"
        className="btn sm"
        disabled={promotePending || config.isPrimary || !config.enabled}
        onClick={onPromote}
      >
        Make primary
      </button>
      <button type="button" className="btn sm" disabled={updatePending} onClick={onToggleEnabled}>
        {config.enabled ? "Disable" : "Enable"}
      </button>
      <button type="button" className="btn sm" disabled={updatePending} onClick={onToggleJit}>
        {config.jitProvisioning ? "Disable JIT" : "Enable JIT"}
      </button>
      <button type="button" className="btn sm" disabled={updatePending} onClick={onEdit}>
        <Icons.EditPen />
        Edit
      </button>
      <button type="button" className="btn sm" disabled={deletePending} onClick={onDelete}>
        <Icons.Trash />
        Delete
      </button>
    </div>
  );
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

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
};

const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: "var(--text-meta)",
  color: "var(--text-2)",
};

const MAPPING_PREVIEW_STYLE: React.CSSProperties = {
  minHeight: 76,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  color: "var(--text)",
  padding: 10,
  fontSize: "var(--text-meta)",
};

const MAPPING_EDITOR_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  padding: 12,
};

const MAPPING_PREVIEW_LIST_STYLE: React.CSSProperties = {
  display: "grid",
  gap: 6,
  margin: 0,
};

const MAPPING_PREVIEW_ROW_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(80px, 0.45fr) minmax(0, 1fr)",
  gap: 8,
  alignItems: "baseline",
};

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

function buildUpdateInput(form: IdpFormState) {
  const input = buildCreateInput(form);
  return {
    protocol: input.protocol,
    displayName: input.displayName,
    config: input.config,
    attrMapping: input.attrMapping,
    signingCertVaultPath: input.signingCertVaultPath,
    enabled: input.enabled,
    isPrimary: input.isPrimary,
    jitProvisioning: input.jitProvisioning,
  };
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
