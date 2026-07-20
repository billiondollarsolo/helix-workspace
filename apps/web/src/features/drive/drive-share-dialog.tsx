import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type CSSProperties } from "react";
import { Icons } from "@/components/icons";
import {
  createDriveShareLink,
  drivePublicShareUrl,
  listDriveAccess,
  removeDriveAccess,
  shareDrive,
  updateDriveAccessRole,
  type DriveAccessGrant,
  type DriveAccessRole,
} from "./api";
import { driveActorQueryOptions, driveQueryKeys } from "./queries";

interface DriveShareDialogProps {
  readonly objectId: string;
  readonly objectName: string;
  readonly ownerActorId?: string | null;
  readonly open: boolean;
  readonly shareUrl?: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
}

export function DriveShareDialog({
  objectId,
  objectName,
  ownerActorId = null,
  open,
  shareUrl,
  onOpenChange,
}: DriveShareDialogProps) {
  const queryClient = useQueryClient();
  const actorQuery = useQuery(driveActorQueryOptions());
  const currentActorId = actorQuery.data?.actorId ?? null;
  const [shareInput, setShareInput] = useState("");
  const [shareRole, setShareRole] = useState<DriveAccessRole>("reader");
  const [copied, setCopied] = useState(false);
  const accessQueryKey = ["drive", "access", objectId] as const;

  const accessQuery = useQuery({
    queryKey: accessQueryKey,
    queryFn: () => listDriveAccess(objectId),
    enabled: false,
    throwOnError: false,
  });
  const { refetch: refetchAccess } = accessQuery;

  useEffect(() => {
    if (open) {
      void refetchAccess();
    }
  }, [open, refetchAccess]);

  const invalidateAccess = async () => {
    await queryClient.invalidateQueries({ queryKey: accessQueryKey });
    if (open) {
      await refetchAccess();
    }
    await queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  };

  const shareMutation = useMutation({
    mutationFn: (input: {
      readonly targets: readonly string[];
      readonly role: DriveAccessRole;
    }) => {
      const targets = driveShareTargetsFromInput(input.targets);
      return shareDrive({
        objectId,
        actorIds: targets.actorIds,
        actorRefs: targets.actorRefs,
        role: input.role,
        expiresAt: null,
      });
    },
    onSuccess: async () => {
      setShareInput("");
      await invalidateAccess();
    },
  });

  const removeAccessMutation = useMutation({
    mutationFn: (actorId: string) => removeDriveAccess(objectId, actorId),
    onSuccess: invalidateAccess,
  });

  const updateAccessMutation = useMutation({
    mutationFn: (input: { readonly actorId: string; readonly role: DriveAccessRole }) =>
      updateDriveAccessRole(objectId, input.actorId, input.role),
    onSuccess: invalidateAccess,
  });

  if (!open) {
    return null;
  }

  const submitShare = () => {
    const targets = shareInput
      .split(/[\s,]+/)
      .map((target) => target.trim())
      .filter((target) => target.length > 0);
    if (targets.length === 0) {
      return;
    }
    shareMutation.mutate({ targets, role: shareRole });
  };

  const copyLink = () => {
    if (navigator.clipboard === undefined) {
      return;
    }
    // Prefer an explicit override URL (in-app deep link for tests/callers).
    // Otherwise create a public share token and copy `/api/drive/share/:token`.
    void (async () => {
      try {
        if (shareUrl !== undefined) {
          await navigator.clipboard.writeText(shareUrl);
          setCopied(true);
          return;
        }
        const link = await createDriveShareLink({ objectId, role: "reader" });
        await navigator.clipboard.writeText(drivePublicShareUrl(link.token));
        setCopied(true);
      } catch {
        // Surface via shareMutation-style error path is heavier; silent fail keeps dialog usable.
      }
    })();
  };

  const busy =
    shareMutation.isPending || removeAccessMutation.isPending || updateAccessMutation.isPending;
  const error =
    shareMutation.error ?? removeAccessMutation.error ?? updateAccessMutation.error ?? null;

  return (
    <div style={overlayStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${objectName}`}
        style={dialogStyle}
      >
        <div style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <h2 style={titleStyle}>Share</h2>
            <div style={subtitleStyle}>{objectName}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close share dialog"
            onClick={() => onOpenChange(false)}
          >
            <Icons.X />
          </button>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle} htmlFor={`share-targets-${objectId}`}>
            Add people
          </label>
          <div style={shareRowStyle}>
            <input
              id={`share-targets-${objectId}`}
              className="input"
              value={shareInput}
              onChange={(event) => setShareInput(event.currentTarget.value)}
              placeholder="Email, name, or actor ID"
              style={{ flex: 1, minWidth: 0 }}
            />
            <select
              className="input"
              aria-label="Share role"
              value={shareRole}
              onChange={(event) => setShareRole(event.currentTarget.value as DriveAccessRole)}
              style={{ width: 128 }}
            >
              {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                <option key={option.role} value={option.role}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || shareInput.trim().length === 0}
            onClick={submitShare}
          >
            <Icons.Users />
            Share
          </button>
          {shareMutation.isSuccess ? <div style={successStyle}>Access granted.</div> : null}
          {error !== null ? (
            <div role="alert" style={errorStyle}>
              {error instanceof Error ? error.message : "Sharing failed."}
            </div>
          ) : null}
        </div>

        <AccessList
          grants={accessQuery.data ?? []}
          loading={accessQuery.isLoading}
          currentActorId={currentActorId}
          ownerActorId={ownerActorId}
          busy={busy}
          onRemove={(actorId) => removeAccessMutation.mutate(actorId)}
          onRoleChange={(actorId, role) => updateAccessMutation.mutate({ actorId, role })}
        />

        {shareUrl !== undefined ? (
          <div style={footerStyle}>
            <button type="button" className="btn sm" onClick={copyLink}>
              <Icons.Link />
              Copy link
            </button>
            {copied ? <span style={successStyle}>Link copied.</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const DRIVE_ACCESS_ROLE_OPTIONS: ReadonlyArray<{
  readonly role: DriveAccessRole;
  readonly label: string;
}> = [
  { role: "reader", label: "Viewer" },
  { role: "commenter", label: "Commenter" },
  { role: "editor", label: "Editor" },
];

function AccessList({
  grants,
  loading,
  currentActorId,
  ownerActorId,
  busy,
  onRemove,
  onRoleChange,
}: {
  readonly grants: readonly DriveAccessGrant[];
  readonly loading: boolean;
  readonly currentActorId: string | null;
  readonly ownerActorId: string | null;
  readonly busy: boolean;
  readonly onRemove: (actorId: string) => void;
  readonly onRoleChange: (actorId: string, role: DriveAccessRole) => void;
}) {
  const canManageAll =
    ownerActorId === null || (currentActorId !== null && ownerActorId === currentActorId);

  if (loading) {
    return <div style={mutedStyle}>Loading access...</div>;
  }

  return (
    <section style={sectionStyle} aria-label="People with access">
      <div style={sectionHeaderStyle}>People with access</div>
      {grants.length === 0 ? (
        <div style={mutedStyle}>Only the owner has access.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {grants.map((grant) => {
            const label = grant.displayName ?? grant.email ?? grant.actorId;
            const canRemove =
              canManageAll || (currentActorId !== null && grant.actorId === currentActorId);
            return (
              <div key={grant.actorId} style={grantRowStyle}>
                <Avatar name={label} />
                <span style={grantLabelStyle}>{label}</span>
                {canManageAll ? (
                  <select
                    className="input"
                    aria-label={`Access role for ${label}`}
                    value={driveAccessRoleValue(grant.role)}
                    disabled={busy}
                    onChange={(event) =>
                      onRoleChange(grant.actorId, event.currentTarget.value as DriveAccessRole)
                    }
                    style={{ width: 124, height: 30, fontSize: "var(--text-caption)" }}
                  >
                    {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                      <option key={option.role} value={option.role}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={mutedStyle}>{driveAccessRoleLabel(grant.role)}</span>
                )}
                {canRemove ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove access for ${label}`}
                    disabled={busy}
                    onClick={() => onRemove(grant.actorId)}
                  >
                    <Icons.X />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Avatar({ name }: { readonly name: string }) {
  return (
    <span aria-hidden="true" style={avatarStyle}>
      {initials(name)}
    </span>
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function driveShareTargetsFromInput(targets: readonly string[]): {
  readonly actorIds: readonly string[];
  readonly actorRefs: readonly string[];
} {
  const actorIds: string[] = [];
  const actorRefs: string[] = [];
  for (const target of targets) {
    if (UUID_PATTERN.test(target)) {
      actorIds.push(target);
    } else {
      actorRefs.push(target);
    }
  }
  return { actorIds, actorRefs };
}

function driveAccessRoleValue(role: string): DriveAccessRole {
  return role === "commenter" || role === "editor" ? role : "reader";
}

function driveAccessRoleLabel(role: string): string {
  return DRIVE_ACCESS_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 80,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "color-mix(in srgb, black 32%, transparent)",
} satisfies CSSProperties;

const dialogStyle = {
  width: "min(560px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 48px)",
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  color: "var(--text)",
  boxShadow: "0 24px 80px rgba(15, 23, 42, 0.24)",
} satisfies CSSProperties;

const headerStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px 18px",
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const titleStyle = {
  margin: 0,
  fontSize: "var(--text-lg)",
  lineHeight: 1.2,
} satisfies CSSProperties;

const subtitleStyle = {
  marginTop: 4,
  color: "var(--text-3)",
  fontSize: "var(--text-body-sm)",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const sectionStyle = {
  display: "grid",
  gap: 10,
  padding: "14px 18px",
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const labelStyle = {
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--text-2)",
} satisfies CSSProperties;

const sectionHeaderStyle = {
  ...labelStyle,
  textTransform: "uppercase",
  letterSpacing: 0,
} satisfies CSSProperties;

const shareRowStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
} satisfies CSSProperties;

const grantRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const grantLabelStyle = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies CSSProperties;

const avatarStyle = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  display: "inline-grid",
  placeItems: "center",
  flexShrink: 0,
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const footerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 18px",
} satisfies CSSProperties;

const mutedStyle = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const successStyle = {
  color: "var(--success, var(--accent))",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const errorStyle = {
  color: "var(--danger, #dc2626)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;
