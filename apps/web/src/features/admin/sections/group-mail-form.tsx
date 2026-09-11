import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "../console/controls";
import { StateBanner } from "../console/primitives";
import { MailAddressInput } from "../mail-address-input";
import type { CreateGroupInput, Group } from "../groups-api";

export function GroupMailForm({
  group,
  onSave,
  onSaved,
}: {
  readonly group?: Group;
  readonly onSave: (input: CreateGroupInput) => Promise<Group>;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [kind, setKind] = useState<NonNullable<CreateGroupInput["kind"]>>(
    group?.kind ?? "mailing_list",
  );
  const [email, setEmail] = useState(group?.email ?? "");
  const [postingPolicy, setPostingPolicy] = useState<"organization" | "anyone">(
    group?.postingPolicy ?? "organization",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function submit() {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({
        name: name.trim(),
        kind,
        email: kind === "mailing_list" ? email : null,
        postingPolicy,
      });
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this group. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="panel mb-3 space-y-3 p-3"
      aria-label={group ? `Mail settings for ${group.name}` : "New group"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onChange={() => setSaved(false)}
    >
      <fieldset disabled={pending} className="min-w-0 space-y-3">
        <legend className="text-sm font-semibold">
          {group ? "Group settings" : "Create a group"}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label={group ? "Group name" : "New group name"}>
            <AdminInput required value={name} onChange={(event) => setName(event.target.value)} />
          </AdminField>
          <AdminField label="Group type">
            <AdminSelect
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as NonNullable<CreateGroupInput["kind"]>)
              }
            >
              <option value="mailing_list">Email group</option>
              <option value="group">Group without email</option>
              <option value="security">Security group</option>
            </AdminSelect>
          </AdminField>
        </div>
        {kind === "mailing_list" ? (
          <>
            <MailAddressInput
              label="Group email"
              value={email}
              purpose="group"
              onChange={setEmail}
            />
            <AdminField label="Who can email this group?">
              <AdminSelect
                value={postingPolicy}
                onChange={(event) =>
                  setPostingPolicy(event.target.value as "organization" | "anyone")
                }
              >
                <option value="organization">Workspace senders only</option>
                <option value="anyone">Anyone, including external senders</option>
              </AdminSelect>
            </AdminField>
            <p className="text-sm text-muted-foreground">
              Workspace senders must be authenticated active users in this workspace, across all its
              domains. External senders remain subject to normal mail filtering. This setting
              controls who can send to the group; members receive its mail.
            </p>
          </>
        ) : group?.email ? (
          <p className="text-sm text-muted-foreground">
            Saving a group without email stops delivery to {group.email}.
          </p>
        ) : null}
        <Button type="submit" disabled={name.trim().length === 0}>
          {pending ? "Saving…" : group ? "Save group settings" : "Create group"}
        </Button>
      </fieldset>
      {error ? <StateBanner kind="error">{error}</StateBanner> : null}
      {saved ? <StateBanner kind="info">Group settings saved.</StateBanner> : null}
    </form>
  );
}
