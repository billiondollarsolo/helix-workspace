/* To, Cc, and Bcc as people-picker chip fields. Cc and Bcc stay hidden
   behind links on the To row until used, like a desktop mail client. */

import { useImperativeHandle, useRef, type Ref } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import type { PersonRef } from "@/features/people/person-ref";
import type { ComposeFields, RecipientField, RecipientProblem } from "./compose-fields";

export interface RecipientFieldsHandle {
  /** Reveal (if needed) and focus a field. */
  focus: (field: RecipientField) => void;
}

interface RecipientFieldsProps {
  readonly fields: Pick<ComposeFields, RecipientField>;
  readonly onChange: (field: RecipientField, refs: PersonRef[]) => void;
  readonly showCc: boolean;
  readonly showBcc: boolean;
  readonly onReveal: (field: "cc" | "bcc") => void;
  readonly problem: RecipientProblem | null;
  readonly errorId: string;
  readonly handleRef?: Ref<RecipientFieldsHandle>;
}

const LABELS: Readonly<Record<RecipientField, string>> = { to: "To", cc: "Cc", bcc: "Bcc" };

export function RecipientFields({
  fields,
  onChange,
  showCc,
  showBcc,
  onReveal,
  problem,
  errorId,
  handleRef,
}: RecipientFieldsProps) {
  const rows = useRef<Partial<Record<RecipientField, HTMLDivElement | null>>>({});
  const focusInput = (field: RecipientField) => {
    rows.current[field]?.querySelector<HTMLInputElement>("input")?.focus();
  };
  useImperativeHandle(handleRef, () => ({
    focus: (field) => {
      if (field !== "to") onReveal(field);
      requestAnimationFrame(() => {
        focusInput(field);
      });
    },
  }));

  const row = (field: RecipientField, links: boolean) => (
    <div
      key={field}
      ref={(node) => {
        rows.current[field] = node;
      }}
      className="compose-row compose-recipient-row"
      data-invalid={problem?.field === field ? "true" : undefined}
      aria-describedby={problem?.field === field ? errorId : undefined}
    >
      <PeoplePicker
        label={LABELS[field]}
        value={fields[field]}
        onChange={(refs) => {
          onChange(field, refs);
        }}
        allowExternal
        allowGroups
      />
      {links ? (
        <span className="compose-reveal-links">
          {showCc ? null : (
            <button
              type="button"
              className="compose-link-btn"
              aria-label="Add Cc recipients"
              onClick={() => {
                onReveal("cc");
                requestAnimationFrame(() => {
                  focusInput("cc");
                });
              }}
            >
              Cc
            </button>
          )}
          {showBcc ? null : (
            <button
              type="button"
              className="compose-link-btn"
              aria-label="Add Bcc recipients"
              onClick={() => {
                onReveal("bcc");
                requestAnimationFrame(() => {
                  focusInput("bcc");
                });
              }}
            >
              Bcc
            </button>
          )}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      {row("to", true)}
      {showCc ? row("cc", false) : null}
      {showBcc ? row("bcc", false) : null}
    </>
  );
}
