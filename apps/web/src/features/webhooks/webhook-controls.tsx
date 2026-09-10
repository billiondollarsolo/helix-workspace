import { Save, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { WebhookDeliveryStatus } from "./types";

/* `value` is `null` when the query behind it has not answered.
 *
 * Every tile used to read `query.data ?? []` and print `.length`, so a
 * workspace whose webhook API was refused or unreachable rendered "0 outbound,
 * 0 inbound, 0 enabled, 0 failed" — four confident zeroes that are
 * indistinguishable from a healthy empty workspace, on the one surface an
 * operator checks to see whether deliveries are failing. A dash is not a
 * count; it says we do not know. */
export function SummaryMetric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly tone?: "danger";
}) {
  const unknown = value === null;
  return (
    <div
      className={
        tone === "danger" && !unknown ? "webhooks-summary-item danger" : "webhooks-summary-item"
      }
      data-unknown={unknown ? "" : undefined}
    >
      <span>{label}</span>
      <strong>{unknown ? "—" : value}</strong>
    </div>
  );
}

export function QueryErrors({ errors }: { readonly errors: readonly (Error | null)[] }) {
  const visibleErrors = errors.filter((error): error is Error => error !== null);
  if (visibleErrors.length === 0) {
    return null;
  }
  return (
    <div className="webhooks-error-panel" role="alert">
      <strong>Webhook API unavailable</strong>
      {/* The heading already says "unavailable"; a backend that answers
          {"error":"unavailable"} used to render "…unavailableunavailable".
          Show the raw message only when it adds something. */}
      <span>{webhookErrorDetail(visibleErrors[0]?.message)}</span>
    </div>
  );
}

/** Drop a backend message that only restates the heading. */
function webhookErrorDetail(message: string | undefined): string {
  const fallback = "Unable to load webhook data.";
  if (message === undefined || message.trim().length === 0) {
    return fallback;
  }
  return message.trim().toLowerCase() === "unavailable" ? fallback : message;
}

export function PanelTitle({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="webhooks-panel-title">
      <h2>{title}</h2>
      <span>{detail}</span>
    </div>
  );
}

export function EditorTitle({
  mode,
  title,
  onCancel,
}: {
  /** `view` is a read-only pane. It used to reuse `edit`, so the delivery
   *  detail — which has no editable field on it — was headed "Edit delivery
   *  detail" and invited the operator to change a historical record. */
  readonly mode: "create" | "edit" | "view";
  readonly title: string;
  readonly onCancel: () => void;
}) {
  const prefix = mode === "create" ? "New " : mode === "edit" ? "Edit " : "";
  return (
    <div className="webhooks-editor-title">
      <h2>
        {prefix}
        {title}
      </h2>
      <button className="icon-button" onClick={onCancel} title="Close editor" type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

export function TextField({
  label,
  onChange,
  value,
  pattern,
  required,
  type = "text",
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
  readonly pattern?: string;
  readonly required?: boolean;
  readonly type?: string;
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <input
        pattern={pattern}
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function TextareaField({
  label,
  onChange,
  rows,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly rows: number;
  readonly value: string;
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  onChange,
  value,
  values,
}: {
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly value: string;
  readonly values: readonly T[];
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FormActions({
  isSaving,
  isLastStep = true,
  onBack,
  onCancel,
  onNext,
}: {
  readonly isSaving: boolean;
  readonly isLastStep?: boolean;
  readonly onBack?: () => void;
  readonly onCancel: () => void;
  readonly onNext?: () => void;
}) {
  return (
    <div className="webhooks-form-actions">
      <button className="helix-button helix-button-secondary" onClick={onCancel} type="button">
        Cancel
      </button>
      {onBack !== undefined ? (
        <button className="helix-button helix-button-secondary" onClick={onBack} type="button">
          Back
        </button>
      ) : null}
      {isLastStep ? (
        <button className="helix-button" disabled={isSaving} type="submit">
          <Save aria-hidden="true" size={16} />
          Save
        </button>
      ) : (
        <button className="helix-button" onClick={onNext} type="button">
          Continue
        </button>
      )}
    </div>
  );
}

interface EditorStepper<Step extends string> {
  readonly step: Step;
  readonly setStep: (step: Step) => void;
  readonly isLastStep: boolean;
  /** `undefined` at the ends of the strip, where `FormActions` omits the
   *  button entirely rather than showing a dead one. */
  readonly onBack: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
}

/** Position within an ordered editor strip. Both editors ran the same
 *  find-index-then-step-one-either-way arithmetic over their own step list. */
export function useEditorStepper<Step extends string>(
  steps: readonly { readonly id: Step; readonly label: string }[],
  initialStep: Step,
): EditorStepper<Step> {
  const [step, setStep] = useState<Step>(initialStep);
  const index = steps.findIndex((item) => item.id === step);
  return {
    step,
    setStep,
    isLastStep: index === steps.length - 1,
    onBack: index > 0 ? () => setStep(steps[index - 1]?.id ?? step) : undefined,
    onNext: index < steps.length - 1 ? () => setStep(steps[index + 1]?.id ?? step) : undefined,
  };
}

export function EditorSteps<Step extends string>({
  activeStep,
  ariaLabel,
  onStepChange,
  steps,
}: {
  readonly activeStep: Step;
  readonly ariaLabel: string;
  readonly onStepChange: (step: Step) => void;
  readonly steps: readonly { readonly id: Step; readonly label: string }[];
}) {
  /* Not a tabset, despite sharing the `.webhooks-tabs` look: these are ordered
     stages of one form, driven mainly by the Back/Continue/Save footer, and the
     step body is part of that form rather than a panel owned by the button. It
     used to claim `role="tab"`/`role="tablist"` with no panels and no keyboard
     interface, which told a screen reader "tab, 1 of 3" and then delivered
     none of it. Plain buttons plus `aria-current="step"` describe what this
     actually is, and they stay in the tab order where a roving tabindex would
     have hidden them. */
  return (
    <div className="webhooks-tabs" role="group" aria-label={ariaLabel}>
      {steps.map((step) => (
        <button
          aria-current={activeStep === step.id ? "step" : undefined}
          /* The app-wide `.tab` look rather than `.webhooks-tab`: the latter
             marks its current item with `[aria-selected="true"]`, which is only
             valid on a real tab and is exactly the attribute dropped here. */
          className={activeStep === step.id ? "tab active" : "tab"}
          key={step.id}
          onClick={() => onStepChange(step.id)}
          type="button"
        >
          {step.label}
        </button>
      ))}
    </div>
  );
}

export function FormError({ message }: { readonly message: string }) {
  return (
    <div className="webhooks-error-panel" role="alert">
      <strong>Review this step</strong>
      <span>{message}</span>
    </div>
  );
}

export function RowActions({ children }: { readonly children: ReactNode }) {
  return <div className="webhooks-row-actions">{children}</div>;
}

export function EmptyRow({ colSpan, text }: { readonly colSpan: number; readonly text: string }) {
  return (
    <tr>
      <td className="webhooks-empty-cell" colSpan={colSpan}>
        {text}
      </td>
    </tr>
  );
}

export function StatusPill({ enabled }: { readonly enabled: boolean }) {
  return (
    <span className={enabled ? "webhooks-pill enabled" : "webhooks-pill disabled"}>
      {enabled ? "enabled" : "disabled"}
    </span>
  );
}

export function DeliveryStatusPill({ status }: { readonly status: WebhookDeliveryStatus }) {
  return <span className={`webhooks-pill ${status}`}>{status}</span>;
}

export function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="webhooks-detail-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
