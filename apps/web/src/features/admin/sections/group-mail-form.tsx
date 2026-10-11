import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "../console/controls";
import { notify } from "@/components/ui/toast";
import { ErrorNotice } from "../console/primitives";
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
  async function submit() {
    setPending(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        kind,
        email: kind === "mailing_list" ? email : null,
        postingPolicy,
      });
      notify({ message: group ? "Group saved" : "Group created" });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this group. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-3"
      aria-label={group ? `Settings for ${group.name}` : "New group"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={pending} className="min-w-0 space-y-3">
        <legend className="sr-only">{group ? "Group settings" : "New group"}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label="Group name">
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
              Mail from outside the organization is still filtered for spam.
            </p>
          </>
        ) : group?.email ? (
          <p className="text-sm text-muted-foreground">
            Saving a group without email stops delivery to {group.email}.
          </p>
        ) : null}
        <Button type="submit" disabled={name.trim().length === 0}>
          {pending ? "Saving…" : group ? "Save" : "Create group"}
        </Button>
      </fieldset>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
    </form>
  );
}
