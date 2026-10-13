/* Shown when a link leads to a Drive item the signed-in person cannot open:
   they can ask its owner for access, with a short note. */
import { useMutation } from "@tanstack/react-query";
import { Lock as LockIcon } from "lucide-react";
import { useId, useState } from "react";
import { InlineError } from "@/components/ui/inline-error";
import { requestDriveAccess } from "./drive-collaboration-api";

export function DriveAccessNeeded({
  itemId,
  kind,
}: {
  readonly itemId: string;
  readonly kind: "file" | "folder";
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const ask = useMutation({
    mutationFn: () => requestDriveAccess(itemId, note),
    // The failure is shown in place; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
  });

  return (
    <section aria-labelledby={`${noteId}-heading`} className="drive-access-needed">
      <LockIcon size={28} aria-hidden="true" />
      <h2 id={`${noteId}-heading`} className="type-h3 m-0">
        You need access
      </h2>
      {ask.isSuccess ? (
        <p className="m-0 type-body-sm text-muted-foreground" role="status">
          The owner has been asked. You’ll get a notification when they answer.
        </p>
      ) : (
        <form
          className="grid w-full gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            ask.mutate();
          }}
        >
          <p className="m-0 type-body-sm text-muted-foreground">
            This {kind} hasn’t been shared with you. Ask its owner to give you access.
          </p>
          <label htmlFor={noteId} className="type-body-sm font-medium">
            Note to the owner (optional)
          </label>
          <textarea
            id={noteId}
            className="input min-h-20"
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {ask.error === null ? null : (
            <InlineError
              variant="compact"
              title="The owner wasn’t asked"
              message={ask.error.message}
            />
          )}
          <div>
            <button type="submit" className="btn primary" disabled={ask.isPending}>
              {ask.isPending ? "Asking" : "Ask for access"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
