/* Share dialog: add people with a role, manage who has access, and set
   general (link) access. Copy link and Done sit in the footer, like Drive. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2 as DomainIcon,
  Globe as AnyoneIcon,
  Link as LinkIcon,
  Lock as LockIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import type { PersonRef } from "@/features/people/person-ref";
import { sessionUserQueryOptions } from "@/lib/auth";
import {
  createDriveShareLink,
  driveItemUrl,
  drivePublicShareUrl,
  removeDriveAccess,
  revokeDriveShareLink,
  shareDrive,
  updateDriveAccessRole,
  type DriveAccessRole,
} from "./api";
import {
  activeShareLinks,
  emailDomain,
  generalAccessFromLinks,
  generalAccessOptions,
  type DriveGeneralAccess,
} from "./drive-general-access";
import {
  driveAccessQueryOptions,
  driveActorQueryOptions,
  driveQueryKeys,
  driveShareLinksQueryOptions,
} from "./queries";
import {
  DRIVE_ACCESS_ROLE_OPTIONS,
  driveAccessRoleLabel,
  driveAccessRoleValue,
} from "./share-access";

export interface DriveShareTarget {
  readonly id: string;
  readonly kind: "file" | "folder";
  readonly name: string;
  readonly ownerActorId: string | null;
  readonly ownerName: string;
}

const REMOVE_ACCESS = "remove";
const ACCESS_ICONS = { restricted: LockIcon, domain: DomainIcon, anyone: AnyoneIcon } as const;

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function DriveShareDialog({
  target,
  onClose,
}: {
  readonly target: DriveShareTarget;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const roleId = useId();
  const accessId = useId();
  const actor = useQuery(driveActorQueryOptions());
  const session = useQuery(sessionUserQueryOptions());
  const currentActorId = actor.data?.actorId ?? null;
  const isOwner = target.ownerActorId === null || target.ownerActorId === currentActorId;
  const domain = emailDomain(session.data?.email);
  const [people, setPeople] = useState<PersonRef[]>([]);
  const [role, setRole] = useState<DriveAccessRole>("reader");
  const [notifyPeople, setNotifyPeople] = useState(true);
  const [note, setNote] = useState("");
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const files = target.kind === "file";

  const access = useQuery(driveAccessQueryOptions(target.id));
  const links = useQuery(driveShareLinksQueryOptions(target.id, files));
  const generalAccess = generalAccessFromLinks(links.data ?? []);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: driveQueryKeys.access(target.id) }),
      queryClient.invalidateQueries({ queryKey: driveQueryKeys.links(target.id) }),
    ]);
  };

  const share = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () =>
      shareDrive({
        objectId: target.id,
        actorIds: people.flatMap((person) => (person.actorId === null ? [] : [person.actorId])),
        role,
        notify: notifyPeople,
        ...(notifyPeople ? { message: note } : {}),
      }),
    onSuccess: async () => {
      notify({
        message: `Shared with ${people.length === 1 ? (people[0]?.displayName ?? "1 person") : `${String(people.length)} people`}`,
      });
      setPeople([]);
      setNote("");
      await refresh();
    },
  });

  const changeRole = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async (input: { readonly actorId: string; readonly value: string }) => {
      if (input.value === REMOVE_ACCESS) {
        await removeDriveAccess(target.id, input.actorId);
        return;
      }
      await updateDriveAccessRole(target.id, input.actorId, driveAccessRoleValue(input.value));
    },
    onSuccess: refresh,
  });

  const setGeneralAccess = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async (next: DriveGeneralAccess) => {
      for (const link of activeShareLinks(links.data ?? [])) {
        await revokeDriveShareLink(link.id);
      }
      if (next === "restricted") return null;
      const created = await createDriveShareLink({
        objectId: target.id,
        allowedDomains: next === "domain" && domain !== null ? [domain] : [],
      });
      return created.token;
    },
    onSuccess: async (token) => {
      setLinkToken(token);
      await refresh();
    },
  });

  const copyLink = () => {
    const url =
      generalAccess !== "restricted" && linkToken !== null
        ? drivePublicShareUrl(linkToken)
        : driveItemUrl(target);
    copyText(url).then(
      () => notify({ message: "Link copied" }),
      () => notify({ message: "Couldn’t copy the link", tone: "error" }),
    );
  };

  const error = share.error ?? changeRole.error ?? setGeneralAccess.error;
  const busy = share.isPending || changeRole.isPending || setGeneralAccess.isPending;
  const accessOptions = generalAccessOptions(domain);
  const currentAccess =
    accessOptions.find((option) => option.value === generalAccess) ?? accessOptions[0];
  const AccessIcon = ACCESS_ICONS[generalAccess];

  return (
    <Dialog
      modal={false}
      title={<h2 className="type-h3 m-0 truncate">Share “{target.name}”</h2>}
      onClose={onClose}
      width="min(560px, calc(100vw - 32px))"
      footer={
        <>
          <button type="button" className="btn mr-auto" onClick={copyLink}>
            <LinkIcon size={16} aria-hidden="true" />
            Copy link
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="drive-share-add">
        <div className="min-w-0 flex-1">
          <PeoplePicker
            label="Add people"
            placeholder="Add people by name or email"
            value={people}
            onChange={setPeople}
          />
        </div>
        <label htmlFor={roleId} className="sr-only">
          Role for new people
        </label>
        <select
          id={roleId}
          className="input w-32"
          value={role}
          onChange={(event) => setRole(driveAccessRoleValue(event.target.value))}
        >
          {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
            <option key={option.role} value={option.role}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {people.length > 0 ? (
        <div className="mt-3 grid gap-2">
          <label className="flex min-h-6 items-center gap-2 type-body-sm">
            <input
              type="checkbox"
              checked={notifyPeople}
              onChange={(event) => setNotifyPeople(event.target.checked)}
            />
            Send them an email
          </label>
          {notifyPeople ? (
            <>
              <label htmlFor={`${roleId}-note`} className="sr-only">
                Note to include
              </label>
              <textarea
                id={`${roleId}-note`}
                className="input min-h-20"
                maxLength={2000}
                placeholder="Add a note (optional)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => share.mutate()}
            >
              Share
            </button>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <div className="mt-3">
          <InlineError variant="compact" title="Sharing didn’t change" message={error.message} />
        </div>
      )}

      <section aria-labelledby={`${accessId}-people`} className="mt-4">
        <h3 id={`${accessId}-people`} className="type-body-sm font-semibold m-0 mb-2">
          People with access
        </h3>
        {access.isLoading ? (
          <Skeleton variant="row" count={2} label="Loading people with access" />
        ) : (
          <ul className="drive-share-people">
            <li className="drive-share-person">
              <Avatar name={target.ownerName} size={32} />
              <span className="min-w-0 flex-1 truncate type-body-sm">
                {target.ownerName}
                {target.ownerActorId === currentActorId ? " (you)" : ""}
              </span>
              <span className="type-caption text-muted-foreground">Owner</span>
            </li>
            {(access.data ?? [])
              .filter((grant) => grant.actorId !== target.ownerActorId && grant.role !== "owner")
              .map((grant) => {
                const name = grant.displayName ?? grant.email ?? "Workspace member";
                return (
                  <li key={grant.actorId} className="drive-share-person">
                    <Avatar name={name} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate type-body-sm">{name}</span>
                      {grant.email !== undefined && grant.email !== name ? (
                        <span className="block truncate type-caption text-muted-foreground">
                          {grant.email}
                        </span>
                      ) : null}
                    </span>
                    {isOwner ? (
                      <select
                        className="input w-36"
                        aria-label={`Access for ${name}`}
                        value={driveAccessRoleValue(grant.role)}
                        disabled={busy}
                        onChange={(event) =>
                          changeRole.mutate({ actorId: grant.actorId, value: event.target.value })
                        }
                      >
                        {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                          <option key={option.role} value={option.role}>
                            {option.label}
                          </option>
                        ))}
                        <option value={REMOVE_ACCESS}>Remove access</option>
                      </select>
                    ) : (
                      <span className="type-caption text-muted-foreground">
                        {driveAccessRoleLabel(grant.role)}
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      {files ? (
        <section aria-labelledby={`${accessId}-general`} className="mt-4">
          <h3 id={`${accessId}-general`} className="type-body-sm font-semibold m-0 mb-2">
            General access
          </h3>
          <div className="drive-share-person">
            <span className="drive-share-access-icon" data-access={generalAccess}>
              <AccessIcon size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${accessId}-select`} className="sr-only">
                General access
              </label>
              <select
                id={`${accessId}-select`}
                className="drive-share-access-select"
                value={generalAccess}
                disabled={!isOwner || busy || links.isLoading}
                onChange={(event) =>
                  setGeneralAccess.mutate(event.target.value as DriveGeneralAccess)
                }
              >
                {accessOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="type-caption text-muted-foreground m-0">{currentAccess?.description}</p>
              {isOwner && generalAccess !== "restricted" && linkToken === null ? (
                <p className="type-caption text-muted-foreground m-0 mt-1">
                  A link is shown only when it is created.{" "}
                  <button
                    type="button"
                    className="drive-link-button"
                    disabled={busy}
                    onClick={() => setGeneralAccess.mutate(generalAccess)}
                  >
                    Create a new link
                  </button>{" "}
                  to copy it; the old one stops working.
                </p>
              ) : null}
            </div>
            {generalAccess === "restricted" ? null : (
              <span className="type-caption text-muted-foreground">Viewer</span>
            )}
          </div>
        </section>
      ) : (
        <p className="type-caption text-muted-foreground mt-4 mb-0">
          People you add get access to everything in this folder.
        </p>
      )}
    </Dialog>
  );
}
