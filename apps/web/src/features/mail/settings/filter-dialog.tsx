/* Create or edit a filter in two steps, as in other mail apps: first the
   criteria (with a match preview), then what to do with matching mail. */

import { queryOptions, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { notify } from "@/components/ui/toast";
import type { MailFilterRecord } from "../api";
import { mailLabelsQueryOptions, mailThreadsQueryOptions } from "../queries";
import type { MailFilterPrefill } from "./dialog-store";
import {
  filterCriteriaQuery,
  filterDraftFromPrefill,
  filterDraftFromRecord,
  filterPayload,
  hasFilterAction,
  hasFilterCriteria,
  type FilterActionsDraft,
  type FilterCriteriaDraft,
  type FilterDraft,
} from "./filter-model";
import { flattenLabelTree } from "./label-model";
import { MailDialog } from "./mail-dialog";
import { errorText, useRetry, useSaveFilter } from "./mutations";

type FilterDialogProps = {
  readonly onClose: () => void;
  readonly initialDraft?: FilterDraft;
} & (
  | { readonly prefill: MailFilterPrefill; readonly filter?: undefined }
  | { readonly filter: MailFilterRecord; readonly prefill?: undefined }
);

export function FilterDialog({ prefill, filter, onClose, initialDraft }: FilterDialogProps) {
  const [draft, setDraft] = useState<FilterDraft>(
    () =>
      initialDraft ??
      (filter === undefined ? filterDraftFromPrefill(prefill) : filterDraftFromRecord(filter)),
  );
  const [step, setStep] = useState<"criteria" | "actions">("criteria");
  const [error, setError] = useState<string | null>(null);
  const save = useSaveFilter();
  const editing = filter !== undefined;

  const setCriteria = (patch: Partial<FilterCriteriaDraft>) => {
    setError(null);
    setDraft((current) => ({ ...current, criteria: { ...current.criteria, ...patch } }));
  };
  const setActions = (patch: Partial<FilterActionsDraft>) => {
    setError(null);
    setDraft((current) => ({ ...current, actions: { ...current.actions, ...patch } }));
  };

  const next = () => {
    if (!hasFilterCriteria(draft.criteria)) {
      setError("Fill in at least one field to say which messages this filter is for.");
      return;
    }
    setStep("actions");
  };
  const submit = () => {
    if (!hasFilterAction(draft)) {
      setError("Choose at least one thing to do with matching messages.");
      return;
    }
    save.mutate(
      { id: filter?.id ?? null, filter: filterPayload(draft) },
      {
        onSuccess: () => {
          notify({ message: editing ? "Filter updated" : "Filter created" });
          onClose();
        },
      },
    );
  };

  const errorNode =
    error === null ? null : (
      <p role="alert" className="m-0 mt-3 type-body-sm text-destructive">
        {error}
      </p>
    );

  if (step === "criteria") {
    return (
      <MailDialog
        title={editing ? "Edit filter" : "Create a filter"}
        description="Step 1 of 2: which messages should this filter catch?"
        onClose={onClose}
        onSubmit={next}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Continue</Button>
          </>
        }
      >
        <CriteriaFields criteria={draft.criteria} onChange={setCriteria} />
        <MatchPreview criteria={draft.criteria} />
        {errorNode}
      </MailDialog>
    );
  }

  return (
    <MailDialog
      title={editing ? "Edit filter" : "Create a filter"}
      description="Step 2 of 2: when a message arrives that matches this search:"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setError(null);
              setStep("criteria");
            }}
          >
            <ArrowLeft aria-hidden="true" />
            Back to search
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
            {editing ? "Update filter" : "Create filter"}
          </Button>
        </>
      }
    >
      <p className="m-0 mb-3 rounded-[var(--radius)] bg-muted px-3 py-2 type-body-sm break-words">
        {filterCriteriaQuery(draft.criteria)}
      </p>
      <ActionFields draft={draft} onChange={setActions} />
      {errorNode}
      {save.error === null ? null : (
        <InlineError
          className="mt-3"
          variant="compact"
          title={editing ? "Couldn't update the filter" : "Couldn't create the filter"}
          message={errorText(save.error, "Check your connection and try again.")}
        />
      )}
    </MailDialog>
  );
}

function TextField({
  label,
  name,
  value,
  onChange,
  type = "text",
}: {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "email";
}) {
  const id = useId();
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr] sm:items-center sm:gap-3">
      <label htmlFor={id} className="type-body-sm text-[var(--text-2)]">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        className="input"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function CriteriaFields({
  criteria,
  onChange,
}: {
  readonly criteria: FilterCriteriaDraft;
  readonly onChange: (patch: Partial<FilterCriteriaDraft>) => void;
}) {
  return (
    <div className="grid gap-3">
      <TextField
        label="From"
        name="filterFrom"
        value={criteria.from}
        onChange={(from) => onChange({ from })}
      />
      <TextField
        label="To"
        name="filterTo"
        value={criteria.to}
        onChange={(to) => onChange({ to })}
      />
      <TextField
        label="Subject"
        name="filterSubject"
        value={criteria.subject}
        onChange={(subject) => onChange({ subject })}
      />
      <TextField
        label="Has the words"
        name="filterHasWords"
        value={criteria.hasWords}
        onChange={(hasWords) => onChange({ hasWords })}
      />
      <label className="flex items-center gap-2 type-body-sm sm:pl-[152px]">
        <input
          type="checkbox"
          name="filterHasAttachment"
          className="focus-ring accent-[var(--accent)]"
          checked={criteria.hasAttachment}
          onChange={(event) => onChange({ hasAttachment: event.target.checked })}
        />
        Has attachment
      </label>
    </div>
  );
}

/** Conversations in every folder matching the query; idle until there is one. */
function filterMatchesQueryOptions(query: string | null) {
  return queryOptions({
    ...mailThreadsQueryOptions({ folder: "all", query: query ?? "", limit: 1 }),
    enabled: query !== null && query !== "",
  });
}

/** "Search" shows how many conversations the criteria match today. */
function MatchPreview({ criteria }: { readonly criteria: FilterCriteriaDraft }) {
  const [query, setQuery] = useState<string | null>(null);
  const current = filterCriteriaQuery(criteria);
  const research = useRetry(filterMatchesQueryOptions(query).queryKey);
  const matches = useQuery(filterMatchesQueryOptions(query));
  let status: ReactNode = null;
  if (query !== null && query === current) {
    if (matches.isFetching) status = "Searching…";
    else if (matches.error !== null) {
      status = `Couldn't search. ${errorText(matches.error, "Try again.")}`;
    } else if (matches.data !== undefined) {
      const total = matches.data.total;
      status =
        total === 0
          ? "No conversations match yet."
          : `${total.toLocaleString()} ${total === 1 ? "conversation matches" : "conversations match"}.`;
    }
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={current === ""}
        onClick={() => {
          setQuery(current);
          if (query === current) research();
        }}
      >
        Search
      </Button>
      <span role="status" className="type-body-sm text-[var(--text-2)]">
        {status}
      </span>
    </div>
  );
}

function ActionFields({
  draft,
  onChange,
}: {
  readonly draft: FilterDraft;
  readonly onChange: (patch: Partial<FilterActionsDraft>) => void;
}) {
  const labels = useQuery(mailLabelsQueryOptions());
  const tree = flattenLabelTree(labels.data ?? []);
  const { actions } = draft;
  const [labelChosen, setLabelChosen] = useState(actions.applyLabel !== "");
  const [labelSlug, setLabelSlug] = useState(actions.applyLabel || (tree[0]?.label.slug ?? ""));
  const checkbox = (key: "skipInbox" | "markRead" | "star" | "delete", text: string) => (
    <label className="flex items-center gap-2 type-body-sm">
      <input
        type="checkbox"
        name={`filter-${key}`}
        className="focus-ring accent-[var(--accent)]"
        checked={actions[key]}
        onChange={(event) => onChange({ [key]: event.target.checked })}
      />
      {text}
    </label>
  );
  const slug = labelSlug || (tree[0]?.label.slug ?? "");
  return (
    <fieldset className="m-0 grid gap-2.5 border-0 p-0">
      <legend className="sr-only">Actions</legend>
      {checkbox("skipInbox", "Skip the Inbox (Archive it)")}
      {checkbox("markRead", "Mark as read")}
      {checkbox("star", "Star it")}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 type-body-sm">
          <input
            type="checkbox"
            name="filter-applyLabel"
            className="focus-ring accent-[var(--accent)]"
            checked={labelChosen}
            disabled={tree.length === 0}
            onChange={(event) => {
              setLabelChosen(event.target.checked);
              onChange({ applyLabel: event.target.checked ? slug : "" });
            }}
          />
          Apply the label:
        </label>
        <select
          name="filterLabel"
          className="select w-auto min-w-40"
          aria-label="Label to apply"
          value={slug}
          disabled={!labelChosen || tree.length === 0}
          onChange={(event) => {
            setLabelSlug(event.target.value);
            onChange({ applyLabel: event.target.value });
          }}
        >
          {tree.length === 0 ? <option value="">No labels yet</option> : null}
          {tree.map((entry) => (
            <option key={entry.label.id} value={entry.label.slug}>
              {entry.path}
            </option>
          ))}
        </select>
      </div>
      {checkbox("delete", "Delete it")}
      {draft.preserved.snoozeUntil === undefined &&
      draft.preserved.extraLabels.length === 0 ? null : (
        <p className="m-0 type-caption text-muted-foreground">
          This filter also has actions set outside this dialog; saving keeps them.
        </p>
      )}
    </fieldset>
  );
}
