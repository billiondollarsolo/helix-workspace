import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SideSheet } from "@/components/ui/side-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingActionsQueryOptions } from "./api";

export interface ActionQueueTrigger {
  readonly total?: number;
  readonly onOpen: () => void;
}

export function ActionQueue({ onClose }: { readonly onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const client = useQueryClient();
  const query = useQuery(pendingActionsQueryOptions(offset));
  return (
    <SideSheet
      open
      title="Action required"
      size="lg"
      description="Review each request before deciding. Opening a request does not approve it."
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {query.isPending ? <Skeleton variant="row" count={3} label="Loading requests" /> : null}
      {query.isError ? (
        <InlineError
          title="Couldn’t load requests"
          message={query.error.message}
          onRetry={() => {
            void client.invalidateQueries({ queryKey: ["pending-actions"] });
          }}
          retrying={query.isFetching}
        />
      ) : null}
      {query.data && !query.isError ? (
        <>
          <p role="status" className="type-body-sm">
            {query.data.total === 0
              ? "No requests need your approval."
              : `${query.data.total} ${query.data.total === 1 ? "request needs" : "requests need"} your approval.`}
          </p>
          <ul className="grid gap-3 list-none p-0">
            {query.data.items.map((item) => (
              <li key={item.id} className="rounded-lg border border-border p-4 grid gap-2">
                <strong className="type-body-sm">{item.toolId}</strong>
                <p className="type-body-sm break-words">{item.preview.consequence}</p>
                <p className="type-meta text-muted-foreground break-words">
                  Requested by {item.actorId}
                </p>
                <p className="type-meta text-muted-foreground">
                  Expires{" "}
                  <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time>
                </p>
                <Link
                  to="/approvals/$pendingId"
                  params={{ pendingId: item.id }}
                  onClick={onClose}
                  className="btn sm"
                >
                  Review request
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={offset + 50 >= query.data.total}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
    </SideSheet>
  );
}
