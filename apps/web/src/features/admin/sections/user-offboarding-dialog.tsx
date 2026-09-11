import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { AdminField, AdminSelect } from "../console/controls";
import { StateBanner } from "../console/primitives";
import { ActorSearchField, useActorPicker } from "../credentials-form-fields";
import type { AdminUser } from "../admin-users";
import { offboardAccount, previewOffboarding, type OffboardPreview } from "../user-offboarding-api";

const RESOURCE_LABELS: Record<keyof OffboardPreview["counts"], string> = {
  driveFiles: "Drive files",
  driveFolders: "Drive folders",
  mailMessages: "Mail messages",
  mailDrafts: "Mail drafts",
  calendars: "Calendars",
  contacts: "Contacts",
  addressBooks: "Address books",
  assistantConversations: "Assistant conversations",
  assistantMemories: "Assistant memories",
};
function UserOffboardingDialog({
  actorId,
  name,
  onClose,
}: {
  readonly actorId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const client = useQueryClient();
  const { actorsQuery, searchDraft, onSearchChange } = useActorPicker();
  const [successor, setSuccessor] = useState<AdminUser | null>(null);
  const [preserveReceivingAddresses, setPreserveReceivingAddresses] = useState(false);
  const [preview, setPreview] = useState<OffboardPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const actors = (actorsQuery.data?.users ?? []).filter(
    (actor) =>
      actor.id !== actorId &&
      actor.disabledAt === null &&
      (actor.type === "user" || actor.type === "agent"),
  );
  const choices = {
    ...(successor ? { successorActorId: successor.id } : {}),
    preserveReceivingAddresses,
  };
  async function review() {
    setPending(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await previewOffboarding(actorId, choices));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not preview account handoff. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  async function execute() {
    if (!preview || preview.blockers.length > 0) return;
    setPending(true);
    setError(null);
    try {
      await offboardAccount(actorId, { ...choices, confirmationToken: preview.confirmationToken });
      setFinished(true);
      toast.success(`Access removed for ${name}. History is preserved.`);
      for (const queryKey of [
        ["admin", "users"],
        ["people", "directory"],
        ["admin", "agent-credentials"],
        ["admin", "app-passwords"],
        ["drive"],
        ["mail"],
        ["calendar"],
        ["assistant"],
      ])
        void client.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not offboard this account. Try again.",
      );
      if (cause instanceof Error && "status" in cause && cause.status === 409) setPreview(null);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      title={`Offboard ${name}`}
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          {finished ? "Done" : "Cancel"}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Remove this account’s workspace access and hand over its owned resources. Existing
          messages, authorship and audit history remain; this does not erase the person or agent
          from historical records.
        </p>
        {finished ? (
          <StateBanner kind="info">
            Access is disabled for {name}.{" "}
            {preview?.successor
              ? `Ownership was handed to ${preview.successor.displayName}.`
              : "There were no owned resources to transfer."}
          </StateBanner>
        ) : (
          <>
            <fieldset disabled={pending} className="min-w-0 space-y-3">
              <legend className="text-sm font-semibold">Choose a successor</legend>
              <ActorSearchField
                id="offboard-successor-search"
                value={searchDraft}
                onChange={onSearchChange}
              />
              <AdminField label="New owner">
                <AdminSelect
                  className="min-w-0 w-full"
                  aria-label="New owner"
                  value={successor?.id ?? ""}
                  disabled={actorsQuery.isPending || actorsQuery.isError}
                  onChange={(event) => {
                    setSuccessor(actors.find((actor) => actor.id === event.target.value) ?? null);
                    setPreview(null);
                    setError(null);
                  }}
                >
                  <option value="">
                    {actorsQuery.isPending ? "Loading accounts…" : "No successor selected"}
                  </option>
                  {successor && !actors.some((actor) => actor.id === successor.id) ? (
                    <option value={successor.id}>
                      {successor.displayName} ({successor.type})
                    </option>
                  ) : null}
                  {actors.map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.displayName} ({actor.type}){actor.email ? ` — ${actor.email}` : ""}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
              <p className="text-sm text-muted-foreground">
                Select an active user or agent in this workspace. A successor is required when the
                account owns resources.
              </p>
              {actorsQuery.data?.nextCursor ? (
                <p className="text-sm text-muted-foreground">
                  Showing the first matching accounts. Search by name, email or ID to find another
                  owner.
                </p>
              ) : null}
              <label className="flex min-h-8 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={preserveReceivingAddresses}
                  onChange={(event) => {
                    setPreserveReceivingAddresses(event.target.checked);
                    setPreview(null);
                    setError(null);
                  }}
                />
                Keep receiving mail at the old addresses
              </label>
              <p className="text-sm text-muted-foreground">
                {preserveReceivingAddresses
                  ? "The successor receives future mail at the listed old addresses. This never grants permission to send as those addresses."
                  : "Future mail to this account’s retired addresses stops."}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void review();
                }}
              >
                {pending ? "Working…" : "Review handoff"}
              </Button>
            </fieldset>
            {actorsQuery.isError ? (
              <StateBanner kind="error">
                {actorsQuery.error.message}{" "}
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    void client.invalidateQueries({ queryKey: ["admin", "users"] });
                  }}
                >
                  Retry accounts
                </Button>
              </StateBanner>
            ) : null}
            {preview ? (
              <section className="space-y-3" aria-label="Account handoff preview">
                <h2 className="text-sm font-semibold">Review account handoff</h2>
                <p className="text-sm">
                  <strong>{preview.source.displayName}</strong> →{" "}
                  <strong>{preview.successor?.displayName ?? "No successor"}</strong>
                  {preview.successor ? ` (${preview.successor.type})` : ""}
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {(Object.keys(RESOURCE_LABELS) as (keyof OffboardPreview["counts"])[]).map(
                    (key) => (
                      <div key={key} className="contents">
                        <dt>{RESOURCE_LABELS[key]}</dt>
                        <dd className="m-0 text-right tabular-nums">{preview.counts[key]}</dd>
                      </div>
                    ),
                  )}
                </dl>
                <p className="text-sm font-medium">
                  {preview.preserveReceivingAddresses
                    ? "Receiving addresses handed over (receive only):"
                    : "Receiving addresses retired:"}
                </p>
                {preview.receivingAddresses.length ? (
                  <ul className="list-inside list-disc break-all text-sm">
                    {preview.receivingAddresses.map((address) => (
                      <li key={address}>{address}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No receiving addresses.</p>
                )}
                {preview.blockers.length ? (
                  <StateBanner kind="error">
                    <ul className="list-inside list-disc">
                      {preview.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </StateBanner>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={pending || actorsQuery.isError}
                    onClick={() => {
                      void execute();
                    }}
                  >
                    {pending ? "Offboarding…" : "Offboard account"}
                  </Button>
                )}
              </section>
            ) : null}
          </>
        )}
        {error ? <StateBanner kind="error">{error}</StateBanner> : null}
      </div>
    </Dialog>
  );
}
export function UserOffboardingButton({
  actorId,
  name,
}: {
  readonly actorId: string;
  readonly name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        aria-label={`Offboard ${name}`}
        onClick={() => setOpen(true)}
      >
        Offboard account
      </Button>
      {open ? (
        <UserOffboardingDialog actorId={actorId} name={name} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
