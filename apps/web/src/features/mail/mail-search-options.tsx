/* "Show search options": a form beside the mail search box that writes the
   operator query (from:, to:, subject:, has:attachment, in:, dates) so
   people do not need to remember the syntax. Opening it reads the current
   query back into the fields. */

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SlidersHorizontal } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { TriggerButton } from "./mail-menus";
import {
  buildMailQuery,
  parseMailQuery,
  SEARCH_SCOPES,
  SEARCH_WITHIN_DAYS,
  type MailSearchOptions,
  type SearchScope,
  type SearchWithinDays,
} from "./mail-search";

const WITHIN_LABELS: Readonly<Record<SearchWithinDays, string>> = {
  1: "1 day",
  3: "3 days",
  7: "1 week",
  14: "2 weeks",
  30: "1 month",
  60: "2 months",
  180: "6 months",
  365: "1 year",
};

export function MailSearchOptions({
  query,
  onSearch,
}: {
  readonly query: string;
  readonly onSearch: (query: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MailSearchOptions>(() => parseMailQuery(query));
  const set = <K extends keyof MailSearchOptions>(key: K, value: MailSearchOptions[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const text = (key: "from" | "to" | "subject" | "words", label: string) => (
    <div className="mail-search-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        className="input"
        value={form[key]}
        onChange={(event) => set(key, event.target.value)}
      />
    </div>
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setOpen(false);
    onSearch(buildMailQuery(form));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(parseMailQuery(query));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <TriggerButton
          className="icon-btn focus-ring mail-search-options-trigger"
          aria-label="Show search options"
          title="Show search options"
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
        </TriggerButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Search options"
        align="end"
        className="w-[min(560px,calc(100vw-16px))]"
      >
        <form className="mail-search-form" onSubmit={submit}>
          {text("from", "From")}
          {text("to", "To")}
          {text("subject", "Subject")}
          {text("words", "Has the words")}
          <div className="mail-search-field">
            <label htmlFor={`${id}-within`}>Date within</label>
            <div className="flex gap-2">
              <select
                id={`${id}-within`}
                className="select"
                value={form.withinDays ?? ""}
                onChange={(event) =>
                  set(
                    "withinDays",
                    event.target.value === ""
                      ? null
                      : (Number(event.target.value) as SearchWithinDays),
                  )
                }
              >
                <option value="">Any time</option>
                {SEARCH_WITHIN_DAYS.map((days) => (
                  <option key={days} value={days}>
                    {WITHIN_LABELS[days]}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="input"
                aria-label="Of date"
                disabled={form.withinDays === null}
                value={form.withinOf}
                onChange={(event) => set("withinOf", event.target.value)}
              />
            </div>
          </div>
          <div className="mail-search-field">
            <label htmlFor={`${id}-scope`}>Search in</label>
            <select
              id={`${id}-scope`}
              className="select"
              value={form.scope}
              onChange={(event) => set("scope", event.target.value as SearchScope)}
            >
              {SEARCH_SCOPES.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
                </option>
              ))}
            </select>
          </div>
          <label className="mail-search-check">
            <input
              type="checkbox"
              checked={form.hasAttachment}
              onChange={(event) => set("hasAttachment", event.target.checked)}
            />
            Has attachment
          </label>
          <div className="mail-search-actions">
            <Button type="submit" size="sm">
              Search
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
