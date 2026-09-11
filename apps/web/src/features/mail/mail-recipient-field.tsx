import type { RefObject } from "react";

export function MailRecipientField({
  label,
  value,
  onChange,
  inputRef,
  error,
}: {
  readonly label: "Cc" | "Bcc";
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly error: string | null;
}) {
  return (
    <div className="flex items-center [padding:4px_0] [border-bottom:1px_solid_var(--border)]">
      <span className="[font-size:var(--text-meta)] text-muted-foreground w-12.5">{label}</span>
      <input
        ref={inputRef}
        name={`mail-compose-${label.toLowerCase()}`}
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : "mail-compose-recipient-error"}
        className="flex-1 [border:none] outline-none bg-transparent [font-size:var(--text-body-sm)]"
      />
    </div>
  );
}
