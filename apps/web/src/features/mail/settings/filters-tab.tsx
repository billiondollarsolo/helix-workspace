/* Filters and blocked addresses: each filter as "matches → does", with Edit
   and Delete; then the addresses whose mail goes straight to Spam. */

import { useQuery } from "@tanstack/react-query";
import { Filter, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { mailFiltersQueryOptions, mailLabelsQueryOptions } from "../queries";
import { BlockedAddresses } from "./blocked-addresses";
import { openFilterDialog, openFilterEditor, openRemoveFilterDialog } from "./dialog-store";
import { describeFilterActions, describeFilterCriteria } from "./filter-model";
import { errorText, useRetry } from "./mutations";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function FiltersTab() {
  return (
    <>
      <FilterList />
      <BlockedAddresses />
    </>
  );
}

function FilterList() {
  const filters = useQuery(mailFiltersQueryOptions());
  const retry = useRetry(mailFiltersQueryOptions().queryKey);
  const labels = useQuery(mailLabelsQueryOptions());
  const createButton = (
    <Button type="button" size="sm" onClick={() => openFilterDialog()}>
      <Plus aria-hidden="true" />
      Add filter
    </Button>
  );

  let body;
  if (filters.data === undefined) {
    body =
      filters.error === null ? (
        <Skeleton variant="text" count={4} label="Loading filters" className="py-4" />
      ) : (
        <InlineError
          title="Couldn't load your filters"
          message={errorText(filters.error, "Check your connection and try again.")}
          onRetry={retry}
          retrying={filters.isFetching}
        />
      );
  } else if (filters.data.length === 0) {
    body = (
      <EmptyState
        size="inline"
        headingLevel={3}
        icon={<Filter />}
        title="No filters yet"
        body="Filters handle new mail for you: skip the Inbox, apply a label, star it or mark it as read."
        action={createButton}
      />
    );
  } else {
    body = (
      <ul className="m-0 list-none p-0" aria-label="Filters">
        {filters.data.map((filter) => {
          const matches = describeFilterCriteria(filter);
          return (
            <li
              key={filter.id}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-border py-3"
            >
              <dl className="m-0 grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 type-body-sm">
                <dt className="text-muted-foreground">Matches</dt>
                <dd className="m-0 break-words">{matches}</dd>
                <dt className="text-muted-foreground">Do this</dt>
                <dd className="m-0 break-words">
                  {describeFilterActions(filter, labels.data ?? [], (iso) =>
                    dateFormat.format(new Date(iso)),
                  )}
                  {filter.enabled ? null : (
                    <span className="ml-2 type-caption text-muted-foreground">(paused)</span>
                  )}
                </dd>
              </dl>
              <span className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit filter ${matches}`}
                  onClick={() => openFilterEditor(filter)}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete filter ${matches}`}
                  onClick={() => openRemoveFilterDialog(filter)}
                >
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby="mail-filters-heading">
      <div className="mt-2 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="mail-filters-heading" className="m-0 type-h3 font-semibold">
            Filters
          </h2>
          <p className="m-0 mt-0.5 type-body-sm text-muted-foreground">
            Filters act on new mail as it arrives.
          </p>
        </div>
        {filters.data !== undefined && filters.data.length > 0 ? createButton : null}
      </div>
      {body}
    </section>
  );
}
