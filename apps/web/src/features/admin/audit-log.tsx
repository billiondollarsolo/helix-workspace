/* Admin › Reporting › Audit log: who did what, when, and how it ended. Rows
 * open a details sheet with the full record, including its raw JSON. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollText as LogIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import { SideSheet } from "@/components/ui/side-sheet";
import {
  adminUsersQueryOptions,
  type AdminUser,
  type AdminUsersQueryInput,
} from "@/features/admin/admin-users";
import {
  LoadingState,
  PageHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { CopyableId, RelativeTime } from "@/features/admin/console/widgets";
import { formatAbsoluteTime } from "@/features/admin/console/format";
import {
  adminAuditLogQueryKeys,
  adminAuditLogQueryOptions,
  defaultAuditLogInput,
  readableEvent,
  type AuditLogQueryInput,
  type AuditLogRecord,
  type AuditOutcome,
} from "./audit-api";
import {
  AuditFilters,
  auditDateBounds,
  EMPTY_AUDIT_FILTERS,
  isFiltered,
  type AuditFilterState,
} from "./audit-filters";

interface AuditLogRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminAuditLogQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminAuditLogQuery(queryClient: AuditLogRouteQueryClient) {
  await queryClient.ensureQueryData(adminAuditLogQueryOptions()).catch(() => undefined);
}

/* Actor names come from the directory, including suspended accounts — they
   are often who an audit search is about. */
const DIRECTORY_LOOKUP_INPUT = {
  includeDisabled: true,
  limit: 250,
} as const satisfies AdminUsersQueryInput;

const OUTCOME_CHIP: Record<AuditOutcome, { readonly tone: string; readonly label: string }> = {
  success: { tone: "success", label: "Succeeded" },
  failure: { tone: "danger", label: "Failed" },
  denied: { tone: "warning", label: "Denied" },
};

function actorName(actorId: string | null, directory: ReadonlyMap<string, AdminUser>): string {
  if (actorId === null || actorId.length === 0) {
    return "No actor";
  }
  const user = directory.get(actorId);
  return user === undefined
    ? "Unknown account"
    : user.displayName || user.email || "Unknown account";
}

function AuditDetailsSheet({
  record,
  directory,
  onClose,
}: {
  readonly record: AuditLogRecord;
  readonly directory: ReadonlyMap<string, AdminUser>;
  readonly onClose: () => void;
}) {
  const outcome = OUTCOME_CHIP[record.outcome];
  const actor = record.actorId === null ? undefined : directory.get(record.actorId);
  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={readableEvent(record.verb)}
      description={formatAbsoluteTime(record.createdAt)}
      size="lg"
    >
      <div className="admin-stack">
        <dl className="admin-facts">
          <div>
            <dt>Outcome</dt>
            <dd>
              <StatusChip tone={outcome.tone} label={outcome.label} />
            </dd>
          </div>
          <div>
            <dt>Actor</dt>
            <dd>
              {actorName(record.actorId, directory)}
              {actor?.email ? <span className="admin-row-detail">{actor.email}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Event</dt>
            <dd>
              <code className="mono">{record.verb}</code>
            </dd>
          </div>
          <div>
            <dt>Object</dt>
            <dd>
              {record.objectType}
              {record.objectId === null ? null : (
                <CopyableId value={record.objectId} label="object ID" />
              )}
            </dd>
          </div>
          {record.actorId === null ? null : (
            <div>
              <dt>Actor ID</dt>
              <dd>
                <CopyableId value={record.actorId} label="actor ID" />
              </dd>
            </div>
          )}
          {record.traceId === null ? null : (
            <div>
              <dt>Trace ID</dt>
              <dd>
                <CopyableId value={record.traceId} label="trace ID" />
              </dd>
            </div>
          )}
          <div>
            <dt>Record hash</dt>
            <dd>
              <CopyableId value={record.thisHash} label="record hash" />
            </dd>
          </div>
        </dl>
        <section aria-labelledby="audit-raw-heading" className="grid gap-2">
          <h3 id="audit-raw-heading" className="m-0 type-body-sm font-semibold">
            Raw record
          </h3>
          <pre className="admin-json" tabIndex={0}>
            {JSON.stringify(record, null, 2)}
          </pre>
        </section>
      </div>
    </SideSheet>
  );
}

export function AuditLogList() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AuditFilterState>(EMPTY_AUDIT_FILTERS);
  /* Cursor of each page visited so far; the last entry is the current page. */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [openRecord, setOpenRecord] = useState<AuditLogRecord | null>(null);
  const cursor = cursors.at(-1);

  const queryInput = useMemo<AuditLogQueryInput>(() => {
    const bounds = auditDateBounds(filters);
    return {
      limit: defaultAuditLogInput.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(filters.actor?.actorId ? { actorId: filters.actor.actorId } : {}),
      ...(filters.verb.length > 0 ? { verb: filters.verb } : {}),
      ...(filters.outcome === "any" ? {} : { outcome: filters.outcome }),
      ...bounds,
    };
    // `auditDateBounds` reads the clock; recompute only when the filters change.
  }, [filters, cursor]);
  const auditQuery = useQuery(adminAuditLogQueryOptions(queryInput));
  const failure = useQueryFailure(auditQuery, () => {
    void queryClient.invalidateQueries({ queryKey: adminAuditLogQueryKeys.list(queryInput) });
  });
  const records = auditQuery.data?.records ?? [];

  const directoryQuery = useQuery(adminUsersQueryOptions(DIRECTORY_LOOKUP_INPUT));
  const directory = useMemo(
    () => new Map((directoryQuery.data?.users ?? []).map((user) => [user.id, user])),
    [directoryQuery.data],
  );
  const verbSuggestions = useMemo(
    () => [...new Set(records.map((record) => record.verb))].sort(),
    [records],
  );

  const changeFilters = (next: AuditFilterState) => {
    setCursors([undefined]);
    setFilters(next);
  };

  const columns: readonly AdminColumn<AuditLogRecord>[] = [
    {
      id: "event",
      header: "Event",
      cell: (record) => (
        <button
          type="button"
          className="admin-audit-event focus-ring"
          onClick={() => setOpenRecord(record)}
        >
          <span className="admin-row-title">{readableEvent(record.verb)}</span>
          <span className="admin-row-detail">{record.objectType}</span>
        </button>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "120px",
      cell: (record) => (
        <StatusChip
          tone={OUTCOME_CHIP[record.outcome].tone}
          label={OUTCOME_CHIP[record.outcome].label}
        />
      ),
    },
    {
      id: "actor",
      header: "Actor",
      width: "28%",
      cell: (record) => {
        const name = actorName(record.actorId, directory);
        return (
          <span className="admin-user-name">
            <Avatar name={name} size={24} />
            <span className="admin-row-title">{name}</span>
          </span>
        );
      },
    },
    {
      id: "date",
      header: "Date",
      width: "140px",
      cell: (record) => <RelativeTime value={record.createdAt} />,
    },
  ];

  return (
    <>
      <PageHeading
        title="Audit log"
        subtitle="A tamper-evident record of admin and security activity, newest first."
      />
      <AuditFilters value={filters} onChange={changeFilters} verbSuggestions={verbSuggestions} />

      {failure !== null ? (
        <QueryFailureBanner
          summary="The audit log couldn't be loaded"
          subject="the audit log"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : auditQuery.isPending ? (
        <LoadingState label="Loading audit records" variant="row" count={8} />
      ) : records.length === 0 ? (
        <EmptyState
          icon={<LogIcon />}
          title={isFiltered(filters) ? "No activity matches these filters" : "No activity yet"}
          body={
            isFiltered(filters)
              ? "Try a wider date range or clear the filters."
              : "Admin and security actions appear here as they happen."
          }
          headingLevel={2}
          size="inline"
        />
      ) : (
        <div className="admin-audit-table">
          <AdminTable
            label="Audit log"
            columns={columns}
            rows={records}
            rowKey={(record) => record.id}
          />
          <Pager
            start={(cursors.length - 1) * defaultAuditLogInput.limit}
            pageCount={records.length}
            total={undefined}
            hasMore={auditQuery.data?.nextCursor !== null}
            loading={auditQuery.isFetching}
            onPrevious={() =>
              setCursors((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
            }
            onNext={() => {
              const next = auditQuery.data?.nextCursor;
              if (next !== null && next !== undefined) {
                setCursors((stack) => [...stack, next]);
              }
            }}
          />
        </div>
      )}

      {openRecord === null ? null : (
        <AuditDetailsSheet
          record={openRecord}
          directory={directory}
          onClose={() => setOpenRecord(null)}
        />
      )}
    </>
  );
}
