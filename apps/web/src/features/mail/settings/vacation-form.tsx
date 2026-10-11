/* Vacation responder: on/off, first and last day, subject and message.
   Each sender gets the reply once per responder period. */

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { MailVacationSettings } from "../api";
import { mailVacationQueryOptions } from "../queries";
import { errorText, useRetry, useSaveVacation } from "./mutations";
import { ChoiceRow, SettingRow } from "./setting-row";
import {
  validateVacationDraft,
  vacationDraftFromSettings,
  vacationInputFromDraft,
  type VacationDraft,
  type VacationErrors,
  type VacationField,
} from "./vacation-model";

export function VacationForm() {
  const vacation = useQuery(mailVacationQueryOptions());
  const retry = useRetry(mailVacationQueryOptions().queryKey);
  if (vacation.data === undefined) {
    return vacation.error === null ? (
      <Skeleton variant="text" count={4} label="Loading vacation responder" className="py-4" />
    ) : (
      <InlineError
        title="Couldn't load your vacation responder"
        message={errorText(vacation.error, "Check your connection and try again.")}
        onRetry={retry}
        retrying={vacation.isFetching}
      />
    );
  }
  return <VacationFields saved={vacation.data} />;
}

const ON_OFF = [
  { value: "off", label: "Vacation responder off" },
  { value: "on", label: "Vacation responder on" },
] as const;

function VacationFields({ saved }: { readonly saved: MailVacationSettings | null }) {
  const ids = useId();
  const save = useSaveVacation();
  const [draft, setDraft] = useState<VacationDraft>(() =>
    vacationDraftFromSettings(saved, new Date()),
  );
  const [errors, setErrors] = useState<VacationErrors>({});
  const update = (patch: Partial<VacationDraft>) => {
    save.reset();
    setErrors({});
    setDraft((current) => ({ ...current, ...patch }));
  };
  const id = (field: VacationField) => `${ids}-${field}`;
  const errorProps = (field: VacationField) =>
    errors[field] === undefined
      ? {}
      : { "aria-invalid": true as const, "aria-describedby": `${id(field)}-error` };
  const fieldError = (field: VacationField) =>
    errors[field] === undefined ? null : (
      <p id={`${id(field)}-error`} className="m-0 mt-1 type-caption text-destructive">
        {errors[field]}
      </p>
    );
  const off = !draft.enabled;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const found = validateVacationDraft(draft);
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        save.mutate(vacationInputFromDraft(draft));
      }}
    >
      <ChoiceRow
        title="Responder"
        hint="Sends an automatic reply to people who email you"
        name="vacation-enabled"
        options={ON_OFF}
        value={draft.enabled ? "on" : "off"}
        onChange={(value) => update({ enabled: value === "on" })}
      />
      <SettingRow title="First day" controlId={id("firstDay")}>
        <input
          id={id("firstDay")}
          name="vacationFirstDay"
          type="date"
          className="input w-auto"
          value={draft.firstDay}
          disabled={off}
          onChange={(event) => update({ firstDay: event.target.value })}
          {...errorProps("firstDay")}
        />
        {fieldError("firstDay")}
      </SettingRow>
      <SettingRow title="Last day" hint="Optional">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 type-body-sm">
            <input
              type="checkbox"
              name="vacationHasLastDay"
              className="focus-ring accent-[var(--accent)]"
              checked={draft.hasLastDay}
              disabled={off}
              onChange={(event) => update({ hasLastDay: event.target.checked })}
            />
            Turn off after
          </label>
          <input
            id={id("lastDay")}
            name="vacationLastDay"
            type="date"
            className="input w-auto"
            aria-label="Last day"
            min={draft.firstDay || undefined}
            value={draft.lastDay}
            disabled={off || !draft.hasLastDay}
            onChange={(event) => update({ lastDay: event.target.value })}
            {...errorProps("lastDay")}
          />
        </div>
        {fieldError("lastDay")}
      </SettingRow>
      <SettingRow title="Subject" controlId={id("subject")}>
        <input
          id={id("subject")}
          name="vacationSubject"
          className="input"
          autoComplete="off"
          maxLength={998}
          value={draft.subject}
          disabled={off}
          placeholder="For example: Out of office until Monday"
          onChange={(event) => update({ subject: event.target.value })}
          {...errorProps("subject")}
        />
        {fieldError("subject")}
      </SettingRow>
      <SettingRow title="Message" controlId={id("message")}>
        <textarea
          id={id("message")}
          name="vacationMessage"
          rows={6}
          className="input h-auto w-full resize-y p-2.5 type-body-sm [line-height:1.5]"
          value={draft.message}
          disabled={off}
          onChange={(event) => update({ message: event.target.value })}
          {...errorProps("message")}
        />
        {fieldError("message")}
        <p className="m-0 mt-2 type-caption text-muted-foreground">
          Each person who writes to you gets this reply once while the responder is on. Mail that
          looks like spam or a mailing list doesn&apos;t get a reply.
        </p>
      </SettingRow>
      <div className="flex flex-wrap items-center gap-3 border-t border-border py-4">
        <Button
          type="submit"
          size="sm"
          disabled={save.isPending}
          aria-busy={save.isPending || undefined}
        >
          Save responder
        </Button>
        <span role="status" className="type-body-sm text-muted-foreground">
          {save.isSuccess
            ? save.data.enabled
              ? "Vacation responder is on."
              : "Vacation responder is off."
            : null}
        </span>
      </div>
      {save.error === null ? null : (
        <InlineError
          variant="compact"
          title="Couldn't save the vacation responder"
          message={errorText(save.error, "Check your connection and try again.")}
        />
      )}
    </form>
  );
}
