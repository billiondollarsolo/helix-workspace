import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as LinkIcon, Users as UsersIcon, X as XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createDriveShareLink,
  drivePublicShareUrl,
  removeDriveAccess,
  shareDrive,
  updateDriveAccessRole,
  type DriveAccessGrant,
  type DriveAccessRole,
} from "./api";
import { driveAccessQueryOptions, driveActorQueryOptions, driveQueryKeys } from "./queries";
import {
  DRIVE_ACCESS_ROLE_OPTIONS,
  driveAccessRoleLabel,
  driveAccessRoleValue,
  driveShareTargetsFromInput,
} from "./share-access";

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
  const [publicPassword, setPublicPassword] = useState("");
  const [publicExpiry, setPublicExpiry] = useState("");
  const [publicDomains, setPublicDomains] = useState("");
  const [oneTime, setOneTime] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const [creatingPublicLink, setCreatingPublicLink] = useState(false);
  const [publicLinkError, setPublicLinkError] = useState<string | null>(null);
  const accessQueryKey = driveQueryKeys.access(objectId);

  const accessQuery = useQuery(driveAccessQueryOptions(objectId, false));
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
    onMutate: () => undefined,
    onError: () => undefined,
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
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (actorId: string) => removeDriveAccess(objectId, actorId),
    onSuccess: invalidateAccess,
  });

  const updateAccessMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
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

  const copyLink = (publicLink = false) => {
    void (async () => {
      setPublicLinkError(null);
      setCreatingPublicLink(true);
      try {
        if (!publicLink && shareUrl !== undefined) {
          await navigator.clipboard.writeText(shareUrl);
        } else {
          const link = await createDriveShareLink({
            objectId,
            ...(publicPassword.length === 0 ? {} : { password: publicPassword }),
            expiresAt: publicExpiry.length === 0 ? null : new Date(publicExpiry).toISOString(),
            oneTime,
            allowedDomains: publicDomains
              .split(/[\s,]+/u)
              .map((domain) => domain.trim().toLowerCase())
              .filter(Boolean),
            allowDownload,
          });
          if (link.token === null) {
            throw new Error("New share link did not return its one-time token.");
          }
          await navigator.clipboard.writeText(drivePublicShareUrl(link.token));
        }
        setCopied(true);
      } catch (cause) {
        setPublicLinkError(cause instanceof Error ? cause.message : "Could not create link.");
      } finally {
        setCreatingPublicLink(false);
      }
    })();
  };

  const busy =
    shareMutation.isPending || removeAccessMutation.isPending || updateAccessMutation.isPending;
  const error =
    shareMutation.error ?? removeAccessMutation.error ?? updateAccessMutation.error ?? null;

  return (
    <div className="fixed inset-0 [z-index:80] grid [place-items:center] p-6 [background:color-mix(in_srgb,_black_32%,_transparent)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${objectName}`}
        className="[width:min(560px,_calc(100vw_-_32px))] [max-height:calc(100vh_-_48px)] overflow-auto [border:1px_solid_var(--border)] rounded-lg bg-card text-foreground [box-shadow:0_24px_80px_rgba(15,_23,_42,_0.24)]"
      >
        <div className="flex items-start gap-3 [padding:16px_18px] [border-bottom:1px_solid_var(--border)]">
          <div className="min-w-0">
            <h2 className="m-0 [font-size:var(--text-lg)] [line-height:1.2]">Share</h2>
            <div className="mt-1 text-muted-foreground [font-size:var(--text-body-sm)] [overflow-wrap:anywhere]">
              {objectName}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close share dialog"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="grid gap-2.5 [padding:14px_18px] [border-bottom:1px_solid_var(--border)]">
          <label
            className="[font-size:var(--text-caption)] font-bold [color:var(--text-2)]"
            htmlFor={`share-targets-${objectId}`}
          >
            Add people
          </label>
          <div className="flex gap-2 items-center">
            <input
              id={`share-targets-${objectId}`}
              className="input flex-1 min-w-0"
              value={shareInput}
              onChange={(event) => {
                setShareInput(event.currentTarget.value);
              }}
              placeholder="Email, name, or actor ID"
            />
            <select
              className="input w-32"
              aria-label="Share role"
              value={shareRole}
              onChange={(event) => {
                setShareRole(event.currentTarget.value as DriveAccessRole);
              }}
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
            <UsersIcon size={16} />
            Share
          </button>
          {shareMutation.isSuccess ? (
            <div className="[color:var(--success,_var(--accent))] [font-size:var(--text-caption)]">
              Access granted.
            </div>
          ) : null}
          {error !== null ? (
            <div
              role="alert"
              className="[color:var(--danger,_#dc2626)] [font-size:var(--text-caption)]"
            >
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
          onRemove={(actorId) => {
            removeAccessMutation.mutate(actorId);
          }}
          onRoleChange={(actorId, role) => {
            updateAccessMutation.mutate({ actorId, role });
          }}
        />

        <details className="grid gap-2.5 [padding:14px_18px] [border-bottom:1px_solid_var(--border)]">
          <summary>Public link settings</summary>
          <p className="text-muted-foreground [font-size:var(--text-caption)]">
            Public links are view-only and can be revoked at any time.
          </p>
          <input
            className="input"
            type="password"
            aria-label="Public link password"
            placeholder="Optional password (12+ characters)"
            value={publicPassword}
            onChange={(event) => {
              setPublicPassword(event.currentTarget.value);
            }}
          />
          <input
            className="input"
            type="datetime-local"
            aria-label="Public link expiry"
            value={publicExpiry}
            onChange={(event) => {
              setPublicExpiry(event.currentTarget.value);
            }}
          />
          <input
            className="input"
            aria-label="Allowed email domains"
            placeholder="Optional domains, comma separated"
            value={publicDomains}
            onChange={(event) => {
              setPublicDomains(event.currentTarget.value);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={oneTime}
              onChange={(event) => {
                setOneTime(event.currentTarget.checked);
              }}
            />{" "}
            Expire after first access
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowDownload}
              onChange={(event) => {
                setAllowDownload(event.currentTarget.checked);
              }}
            />{" "}
            Allow download
          </label>
        </details>
        <div className="flex items-center gap-2.5 [padding:12px_18px]">
          {shareUrl === undefined ? null : (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                copyLink();
              }}
            >
              <LinkIcon size={16} />
              Copy link
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={
              creatingPublicLink ||
              (publicPassword.length > 0 && publicPassword.length < 12) ||
              (publicExpiry.length > 0 && !Number.isFinite(new Date(publicExpiry).valueOf()))
            }
            onClick={() => {
              copyLink(true);
            }}
          >
            <LinkIcon size={16} />
            Create public link
          </button>
          {copied ? (
            <span className="[color:var(--success,_var(--accent))] [font-size:var(--text-caption)]">
              Link copied.
            </span>
          ) : null}
          {publicLinkError === null ? null : (
            <span
              role="alert"
              className="[color:var(--danger,_#dc2626)] [font-size:var(--text-caption)]"
            >
              {publicLinkError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

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
    return (
      <div className="text-muted-foreground [font-size:var(--text-caption)]">Loading access...</div>
    );
  }

  return (
    <section
      className="grid gap-2.5 [padding:14px_18px] [border-bottom:1px_solid_var(--border)]"
      aria-label="People with access"
    >
      <div className="[font-size:var(--text-caption)] font-bold [color:var(--text-2)] uppercase [letter-spacing:0]">
        People with access
      </div>
      {grants.length === 0 ? (
        <div className="text-muted-foreground [font-size:var(--text-caption)]">
          Only the owner has access.
        </div>
      ) : (
        <div className="grid gap-2">
          {grants.map((grant) => {
            const label = grant.displayName ?? grant.email ?? grant.actorId;
            const canRemove =
              canManageAll || (currentActorId !== null && grant.actorId === currentActorId);
            return (
              <div
                key={grant.actorId}
                className="flex items-center gap-2 min-w-0 [font-size:var(--text-body-sm)]"
              >
                <Avatar name={label} />
                <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {label}
                </span>
                {canManageAll ? (
                  <select
                    className="input w-31 h-7.5 [font-size:var(--text-caption)]"
                    aria-label={`Access role for ${label}`}
                    value={driveAccessRoleValue(grant.role)}
                    disabled={busy}
                    onChange={(event) => {
                      onRoleChange(grant.actorId, event.currentTarget.value as DriveAccessRole);
                    }}
                  >
                    {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                      <option key={option.role} value={option.role}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-muted-foreground [font-size:var(--text-caption)]">
                    {driveAccessRoleLabel(grant.role)}
                  </span>
                )}
                {canRemove ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove access for ${label}`}
                    disabled={busy}
                    onClick={() => {
                      onRemove(grant.actorId);
                    }}
                  >
                    <XIcon size={16} />
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
    <span
      aria-hidden="true"
      className="w-6 h-6 rounded-full [display:inline-grid] [place-items:center] shrink-0 [background:var(--accent-soft)] text-primary [font-size:var(--text-caption)] font-bold"
    >
      {initials(name)}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
