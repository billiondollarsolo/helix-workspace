/* Right-hand details panel with Details and Activity tabs. Shows facts about
   the selected file or folder; actions live in the menus and toolbar. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X as CloseIcon } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { revertDriveVersion, type DriveAccessGrant, type DriveVersion } from "./api";
import { formatByteSize, formatDateTime, formatModified, type DriveItem } from "./drive-data";
import { DriveTypeIcon, DRIVE_TYPE_META } from "./drive-type-icon";
import { driveAccessQueryOptions, driveQueryKeys, driveVersionsQueryOptions } from "./queries";
import { driveAccessRoleLabel } from "./share-access";
import { driveUploadStatusView, openDenialMessage } from "./upload-status-ui";

type DetailsTab = "details" | "activity";
const TABS: readonly { readonly id: DetailsTab; readonly label: string }[] = [
  { id: "details", label: "Details" },
  { id: "activity", label: "Activity" },
];

interface ActivityEvent {
  readonly key: string;
  readonly who: string;
  readonly what: string;
  readonly at: string;
}

/** Newest-first activity derived from the item, its versions and its grants. */
function driveActivityEvents(
  item: DriveItem,
  ownerLabel: string,
  versions: readonly DriveVersion[],
  grants: readonly DriveAccessGrant[],
  nameForActor: (actorId: string | null) => string,
): ActivityEvent[] {
  const noun = item.kind === "folder" ? "folder" : "file";
  const events: ActivityEvent[] = [
    { key: "created", who: ownerLabel, what: `created this ${noun}`, at: item.createdAt },
  ];
  for (const version of versions) {
    if (version.versionNumber === 1) continue;
    events.push({
      key: `version-${String(version.versionNumber)}`,
      who: nameForActor(version.createdByActorId),
      what: `uploaded version ${String(version.versionNumber)}`,
      at: version.createdAt,
    });
  }
  for (const grant of grants) {
    if (grant.role === "owner") continue;
    events.push({
      key: `grant-${grant.actorId}`,
      who: nameForActor(grant.grantedByActorId),
      what: `shared with ${grant.displayName ?? grant.email ?? "a member"} as ${driveAccessRoleLabel(grant.role).toLowerCase()}`,
      at: grant.createdAt,
    });
  }
  if (versions.length === 0 && item.updatedAt !== item.createdAt) {
    events.push({ key: "modified", who: ownerLabel, what: "made changes", at: item.updatedAt });
  }
  if (item.deletedAt !== null) {
    events.push({
      key: "trashed",
      who: "Someone",
      what: "moved this to trash",
      at: item.deletedAt,
    });
  }
  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="drive-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function VersionHistory({ item, busy }: { readonly item: DriveItem; readonly busy: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<number | null>(null);
  const versions = useQuery(driveVersionsQueryOptions(item.id, item.kind === "file"));
  const revert = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (versionNumber: number) => revertDriveVersion(item.id, versionNumber),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const list = versions.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-label="Version history" className="mt-4">
      <h3 className="type-body-sm font-semibold m-0 mb-2">Version history</h3>
      <ul className="grid gap-1.5 p-0 m-0 list-none">
        {list.slice(0, 10).map((version, index) => (
          <li key={version.versionNumber} className="flex items-center gap-2 type-caption">
            <span className="min-w-0 flex-1 truncate">
              Version {String(version.versionNumber)} · {formatByteSize(version.byteSize)} ·{" "}
              {formatModified(version.createdAt)}
            </span>
            {index === 0 ? (
              <span className="text-muted-foreground">Current</span>
            ) : confirming === version.versionNumber ? (
              <>
                <button
                  type="button"
                  className="btn sm primary"
                  aria-label={`Confirm restore of version ${String(version.versionNumber)}`}
                  disabled={busy || revert.isPending}
                  onClick={() => revert.mutate(version.versionNumber)}
                >
                  Restore
                </button>
                <button type="button" className="btn sm" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn sm"
                aria-label={`Restore version ${String(version.versionNumber)}`}
                disabled={busy || revert.isPending}
                onClick={() => {
                  revert.reset();
                  setConfirming(version.versionNumber);
                }}
              >
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
      {revert.error === null ? null : (
        <p role="alert" className="type-caption text-[var(--danger)] mt-1 mb-0">
          {revert.error.message}
        </p>
      )}
    </section>
  );
}

export function DriveDetailsPanel({
  item,
  ownerLabel,
  location,
  isTrash,
  busy,
  currentActorId,
  onClose,
  onManageAccess,
}: {
  readonly item: DriveItem | null;
  readonly ownerLabel: string;
  readonly location: string;
  readonly isTrash: boolean;
  readonly busy: boolean;
  readonly currentActorId: string | null;
  readonly onClose: () => void;
  readonly onManageAccess: () => void;
}) {
  const baseId = useId();
  const [tab, setTab] = useState<DetailsTab>("details");
  const tabRefs = useRef(new Map<DetailsTab, HTMLButtonElement>());
  const readable = item !== null && !isTrash;
  const access = useQuery(driveAccessQueryOptions(item?.id ?? "", readable));
  const versions = useQuery(
    driveVersionsQueryOptions(item?.id ?? "", readable && item.kind === "file"),
  );
  const grants = (access.data ?? []).filter((grant) => grant.role !== "owner");

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: DetailsTab = tab === "details" ? "activity" : "details";
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const nameForActor = (actorId: string | null) => {
    if (actorId === null) return "Someone";
    if (actorId === currentActorId) return "You";
    if (actorId === item?.ownerActorId) return item.owner;
    const grant = access.data?.find((candidate) => candidate.actorId === actorId);
    return grant?.displayName ?? grant?.email ?? "A member";
  };

  const status = item === null ? null : driveUploadStatusView(item.uploadState);

  return (
    <aside aria-label="Details" className="drive-details" data-testid="drive-details-panel">
      <div className="drive-details-header">
        {item === null ? null : <DriveTypeIcon type={item.type} size={22} />}
        <h2 className="type-body m-0 font-semibold truncate flex-1" title={item?.name}>
          {item?.name ?? location}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>
      <div role="tablist" aria-label="Details panel" className="drive-details-tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            ref={(node) => {
              if (node) tabRefs.current.set(entry.id, node);
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`${baseId}-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className="drive-details-tab"
            onClick={() => setTab(entry.id)}
            onKeyDown={onTabKeyDown}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="drive-details-body"
      >
        {item === null ? (
          <EmptyState
            size="inline"
            headingLevel={3}
            icon={<DriveTypeIcon type="folder" size={28} />}
            title="Select a file or folder"
            body="Its details and activity show up here."
          />
        ) : tab === "details" ? (
          <>
            <div className="drive-details-hero" aria-hidden="true">
              <DriveTypeIcon type={item.type} size={64} />
            </div>
            {status !== null && !status.available ? (
              <p
                role="status"
                className="drive-upload-tone type-caption rounded-md px-2.5 py-2 mb-3"
                data-tone={status.tone}
              >
                {openDenialMessage(status.state)}
              </p>
            ) : null}
            {readable ? (
              <section aria-label="Who has access" className="mb-4">
                <h3 className="type-body-sm font-semibold m-0 mb-2">Who has access</h3>
                <div className="flex items-center gap-1 mb-2">
                  <Avatar name={item.owner} size={28} />
                  {grants.slice(0, 5).map((grant) => (
                    <Avatar
                      key={grant.actorId}
                      name={grant.displayName ?? grant.email ?? "Member"}
                      size={28}
                    />
                  ))}
                  {grants.length > 5 ? (
                    <span className="type-caption text-muted-foreground">
                      +{String(grants.length - 5)}
                    </span>
                  ) : null}
                </div>
                <p className="type-caption text-muted-foreground m-0 mb-2">
                  {grants.length === 0
                    ? "Private to the owner"
                    : `Owned by ${ownerLabel}. Shared with ${String(grants.length)} ${grants.length === 1 ? "person" : "people"}.`}
                </p>
                <button type="button" className="btn sm" onClick={onManageAccess}>
                  Manage access
                </button>
              </section>
            ) : null}
            <h3 className="type-body-sm font-semibold m-0 mb-1">
              {item.kind === "folder" ? "Folder details" : "File details"}
            </h3>
            <dl className="drive-detail-list">
              <DetailRow label="Type" value={DRIVE_TYPE_META[item.type].label} />
              {item.kind === "file" ? (
                <DetailRow label="Size" value={formatByteSize(item.byteSize)} />
              ) : null}
              <DetailRow label="Location" value={location} />
              <DetailRow label="Owner" value={ownerLabel} />
              <DetailRow label="Modified" value={formatDateTime(item.updatedAt)} />
              <DetailRow label="Created" value={formatDateTime(item.createdAt)} />
              {item.deletedAt === null ? null : (
                <DetailRow label="Moved to trash" value={formatDateTime(item.deletedAt)} />
              )}
            </dl>
            {readable && item.kind === "file" ? <VersionHistory item={item} busy={busy} /> : null}
          </>
        ) : (
          <ul className="drive-activity">
            {driveActivityEvents(
              item,
              ownerLabel === "me" ? "You" : ownerLabel,
              versions.data ?? [],
              grants,
              nameForActor,
            ).map((event) => (
              <li key={event.key} className="drive-activity-row">
                <Avatar name={event.who === "You" ? item.owner : event.who} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="type-body-sm m-0">
                    <span className="font-semibold">{event.who}</span> {event.what}
                  </p>
                  <p className="type-caption text-muted-foreground m-0">
                    {formatDateTime(event.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
