import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import { vaultDraftSchema, type VaultDraft } from "./vault-model";

export function VaultEditor({
  item,
  pending,
  onSave,
  onClose,
  onTrash,
}: {
  readonly item: VaultDraft;
  readonly pending: boolean;
  readonly onSave: (draft: VaultDraft) => void;
  readonly onClose: () => void;
  readonly onTrash: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(item);
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "trash" | null>(null);
  const [validation, setValidation] = useState("");
  const dirty = (["name", "username", "password", "website", "notes"] as const).some(
    (field) => draft[field] !== item[field],
  );
  const warning = useUnsavedChangesWarning(dirty, "vault item", {
    message: "Leaving discards this unsaved draft and locks your vault.",
  });
  const change = (field: keyof VaultDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setValidation("");
  };
  return (
    <section
      className="grid content-start gap-4 rounded-lg border border-outline p-4"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="m-0 text-lg font-semibold">
          {item.id ? "Edit vault item" : "New vault item"}
        </h2>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => (dirty ? setConfirm("discard") : onClose())}
        >
          Close
        </Button>
      </div>
      <form
        className="grid gap-4"
        aria-label="Vault item"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = vaultDraftSchema.safeParse(draft);
          if (!parsed.success)
            setValidation(parsed.error.issues[0]?.message ?? "Check the item details.");
          else if (!pending) onSave(parsed.data);
        }}
      >
        <fieldset className="m-0 grid gap-4 border-0 p-0" disabled={pending}>
          <legend className="sr-only">Item details</legend>
          <div className="grid gap-1">
            <label htmlFor={`${id}-name`}>Item name</label>
            <input
              id={`${id}-name`}
              className="input w-full"
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
              required
              maxLength={500}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-username`}>Username</label>
            <input
              id={`${id}-username`}
              className="input w-full"
              value={draft.username}
              onChange={(event) => change("username", event.target.value)}
              maxLength={1000}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-password`}>Password</label>
            <div className="flex items-center gap-2">
              <input
                id={`${id}-password`}
                className="input w-full"
                type={reveal ? "text" : "password"}
                value={draft.password}
                onChange={(event) => change("password", event.target.value)}
                maxLength={1000}
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="outline"
                aria-pressed={reveal}
                onClick={() => setReveal(!reveal)}
              >
                {reveal ? "Hide" : "Show"}
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-website`}>Website</label>
            <input
              id={`${id}-website`}
              className="input w-full"
              type="url"
              pattern="https?://.*"
              value={draft.website}
              onChange={(event) => change("website", event.target.value)}
              maxLength={2000}
              autoComplete="off"
              aria-describedby={`${id}-website-help`}
            />
            <p id={`${id}-website-help`} className="m-0 text-sm text-[var(--text-3)]">
              Use https:// or http://. Helix never fetches this address.
            </p>
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-notes`}>Notes</label>
            <textarea
              id={`${id}-notes`}
              className="input h-auto w-full resize-y"
              rows={5}
              value={draft.notes}
              onChange={(event) => change("notes", event.target.value)}
              maxLength={10000}
              autoComplete="off"
            />
          </div>
          {validation ? (
            <p className="m-0 text-destructive" role="alert">
              {validation}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={item.id !== undefined && !dirty}>
              {pending ? "Saving…" : "Save item"}
            </Button>
            {item.id ? (
              <Button type="button" variant="outline" onClick={() => setConfirm("trash")}>
                Move to trash
              </Button>
            ) : null}
          </div>
        </fieldset>
      </form>
      {warning}
      {confirm ? (
        <Dialog
          title={confirm === "trash" ? "Move this item to trash?" : "Discard this draft?"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (confirm === "trash") {
                    setConfirm(null);
                    onTrash();
                  } else onClose();
                }}
              >
                {confirm === "trash" ? "Move to trash" : "Discard draft"}
              </Button>
            </>
          }
        >
          <p>
            {confirm === "trash"
              ? "The item stays in the encrypted recycle bin and can be restored in a KeePass-compatible app."
              : "Your unsaved changes will be discarded."}
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
