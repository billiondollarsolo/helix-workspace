/* Import contacts from a .vcf or .csv file. The server validates the file
   first (a dry run) and the dialog shows how many contacts it holds before
   anything is saved. */
import { CONTACT_LIMITS, type ContactImportResult } from "@helix/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp as FileIcon } from "lucide-react";
import { useId, useState } from "react";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { notify } from "@/components/ui/toast";
import { contactsQueryKeys, importContacts } from "./api";

interface PreparedFile {
  readonly name: string;
  readonly format: "vcard" | "csv";
  readonly content: string;
  readonly preview: ContactImportResult;
}

const LABEL_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** `Imported Oct 11, 2026`, without the characters labels cannot hold. */
export function importLabel(now: Date): string {
  return `Imported ${LABEL_DATE.format(now)}`.replace(/[,;\\]/gu, "");
}

export function importFormat(file: Pick<File, "name" | "type">): "vcard" | "csv" | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".vcf") || name.endsWith(".vcard") || file.type === "text/vcard")
    return "vcard";
  if (name.endsWith(".csv") || file.type === "text/csv") return "csv";
  return null;
}

export function ImportContactsDialog({
  onClose,
  onImported,
}: {
  readonly onClose: () => void;
  /** Called with the label the contacts were filed under. */
  readonly onImported: (label: string | null) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [prepared, setPrepared] = useState<PreparedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addLabel, setAddLabel] = useState(true);
  const label = importLabel(new Date());

  const choose = async (file: File | undefined) => {
    setPrepared(null);
    setError(null);
    if (file === undefined) return;
    const format = importFormat(file);
    if (format === null) {
      setError("Choose a vCard (.vcf) or CSV (.csv) file.");
      return;
    }
    if (file.size > CONTACT_LIMITS.importBytes) {
      setError("This file is larger than 900 KB. Split it into smaller files and import each one.");
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      const preview = await importContacts({ format, content, dryRun: true });
      setPrepared({ name: file.name, format, content, preview });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The file could not be read.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (prepared === null) return;
    setBusy(true);
    try {
      const result = await importContacts({
        format: prepared.format,
        content: prepared.content,
        dryRun: false,
        ...(addLabel ? { label } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: contactsQueryKeys.all });
      notify({
        message:
          result.count === 1
            ? "Imported 1 contact"
            : `Imported ${result.count.toLocaleString()} contacts`,
        ...(result.skipped > 0
          ? {
              description: `${result.skipped.toLocaleString()} could not be read and were skipped.`,
            }
          : {}),
      });
      onImported(addLabel ? label : null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The contacts could not be imported.");
      setBusy(false);
    }
  };

  const preview = prepared?.preview;
  return (
    <Dialog
      title={<h2 className="type-h3 m-0">Import contacts</h2>}
      onClose={onClose}
      width="min(480px, 100%)"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || preview === undefined || preview.count === 0}
            aria-busy={busy || undefined}
            onClick={() => void save()}
          >
            {preview === undefined || preview.count === 0
              ? "Import"
              : `Import ${preview.count.toLocaleString()}`}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="m-0 type-body-sm text-muted-foreground">
          Choose a vCard (.vcf) or CSV file exported from another contacts app or email service.
          Files can be up to 900 KB.
        </p>
        <label htmlFor={`${id}-file`} className="contacts-file-picker">
          <FileIcon size={18} aria-hidden="true" />
          <span>{prepared?.name ?? "Select file"}</span>
          <input
            id={`${id}-file`}
            type="file"
            accept=".vcf,.vcard,.csv,text/vcard,text/csv"
            className="sr-only"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {busy && preview === undefined ? (
          <p role="status" className="m-0 type-body-sm">
            Checking the file…
          </p>
        ) : null}
        {preview === undefined ? null : (
          <section aria-label="Import preview" className="contacts-import-preview" role="status">
            <p className="m-0 type-body font-medium">
              {preview.count === 0
                ? "No contacts can be imported from this file."
                : preview.count === 1
                  ? "1 contact is ready to import."
                  : `${preview.count.toLocaleString()} contacts are ready to import.`}
            </p>
            {preview.sample.length > 0 ? (
              <p className="m-0 type-body-sm text-muted-foreground">
                {preview.sample.join(", ")}
                {preview.count > preview.sample.length ? ", …" : ""}
              </p>
            ) : null}
            {preview.skipped > 0 || preview.problems.length > 0 ? (
              <details className="type-body-sm">
                <summary>
                  {preview.skipped === 1
                    ? "1 entry will be skipped"
                    : `${preview.skipped.toLocaleString()} entries will be skipped`}
                </summary>
                <ul className="m-0 mt-1 pl-5">
                  {preview.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        )}
        {preview !== undefined && preview.count > 0 ? (
          <label className="flex items-center gap-2 type-body-sm">
            <input
              type="checkbox"
              className="focus-ring accent-[var(--accent)]"
              checked={addLabel}
              onChange={(event) => setAddLabel(event.target.checked)}
            />
            Add the label “{label}”
          </label>
        ) : null}
        {error === null ? null : (
          <InlineError variant="compact" title="Couldn’t import" message={error} />
        )}
      </div>
    </Dialog>
  );
}
