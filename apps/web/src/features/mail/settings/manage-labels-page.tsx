/* Labels: every label as a tree with its color and conversation count, and
   Create / Edit / Remove. Org-wide labels are listed but only admins change them. */

import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { mailLabelsQueryOptions } from "../queries";
import { openLabelDialog, openRemoveLabelDialog } from "./dialog-store";
import { flattenLabelTree, labelColorTitle, labelColorVar } from "./label-model";
import { errorText, useRetry } from "./mutations";

export function ManageLabelsPage() {
  const labels = useQuery(mailLabelsQueryOptions());
  const retry = useRetry(mailLabelsQueryOptions().queryKey);
  const createButton = (
    <Button type="button" size="sm" onClick={() => openLabelDialog({ mode: "create" })}>
      <Plus aria-hidden="true" />
      Create new label
    </Button>
  );

  let body;
  if (labels.data === undefined) {
    body =
      labels.error === null ? (
        <Skeleton variant="text" count={5} label="Loading labels" className="py-4" />
      ) : (
        <InlineError
          title="Couldn't load your labels"
          message={errorText(labels.error, "Check your connection and try again.")}
          onRetry={retry}
          retrying={labels.isFetching}
        />
      );
  } else if (labels.data.length === 0) {
    body = (
      <EmptyState
        size="inline"
        headingLevel={3}
        icon={<Tag />}
        title="No labels yet"
        body="Labels sort conversations your way. A conversation can have several labels."
        action={createButton}
      />
    );
  } else {
    body = (
      <ul className="m-0 list-none p-0" aria-label="Labels">
        {flattenLabelTree(labels.data).map(({ label, depth, path }) => (
          <li
            key={label.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2.5"
          >
            <span
              className="flex min-w-0 flex-1 items-center gap-2.5"
              style={{ paddingInlineStart: `${String(depth * 20)}px` }}
            >
              <span
                className="size-3 shrink-0 rounded-sm"
                style={{ background: labelColorVar(label.colorName) }}
                role="img"
                aria-label={`${labelColorTitle(label.colorName)} label`}
              />
              <span className="min-w-0 truncate type-body-sm font-medium" title={path}>
                {label.name}
              </span>
              <span className="shrink-0 type-caption text-muted-foreground">
                {label.threadCount.toLocaleString()}{" "}
                {label.threadCount === 1 ? "conversation" : "conversations"}
              </span>
            </span>
            {label.shared ? (
              <span className="type-caption text-muted-foreground">
                Shared by your organization
              </span>
            ) : (
              <span className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${path}`}
                  onClick={() => openLabelDialog({ mode: "edit", labelId: label.id })}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${path}`}
                  onClick={() => openRemoveLabelDialog(label.id)}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="mail-labels-heading">
      <div className="mt-2 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="mail-labels-heading" className="m-0 type-h3 font-semibold">
            Labels
          </h2>
          <p className="m-0 mt-0.5 type-body-sm text-muted-foreground">
            Edit a label to rename it, change its color or nest it under another label.
          </p>
        </div>
        {labels.data !== undefined && labels.data.length > 0 ? createButton : null}
      </div>
      {body}
    </section>
  );
}
