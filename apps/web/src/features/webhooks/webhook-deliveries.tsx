import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { WebhookDeliveryListInput } from "./api";
import { webhookDeliveryStatuses } from "./api";
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookDirection } from "./types";
import {
  DeliveryStatusPill,
  DetailRow,
  EditorTitle,
  EmptyRow,
  PanelTitle,
  TextField,
} from "./webhook-controls";
import { formatDate } from "./webhook-format";

/** True when the operator has narrowed the delivery log beyond the default page
 *  the overview already returns. Only then is a second request worth spending
 *  against the tenant's five-per-second budget. */
export function isFilteredDeliveryInput(input: WebhookDeliveryListInput): boolean {
  return (
    input.direction !== undefined ||
    input.status !== undefined ||
    input.webhookId !== undefined ||
    input.createdAfter !== undefined ||
    input.createdBefore !== undefined
  );
}

export interface DeliveryFilterState {
  readonly direction: "" | WebhookDirection;
  readonly status: "" | WebhookDeliveryStatus;
  readonly webhookId: string;
  readonly createdAfter: string;
  readonly createdBefore: string;
  readonly limit: string;
}

/** The endpoint a delivery belongs to, by name where we know it.
 *
 *  Falls back to the id rather than to a dash: a delivery whose endpoint has
 *  since been deleted still has to be identifiable, and an em dash there would
 *  read as "no endpoint" when the truth is "an endpoint that no longer exists". */
function deliveryEndpointLabel(
  delivery: WebhookDelivery,
  names: ReadonlyMap<string, string>,
): string {
  const id = delivery.outboundWebhookId ?? delivery.inboundWebhookId;
  if (id === null) {
    return "—";
  }
  return names.get(id) ?? id;
}

/** Replaying only makes sense for an outbound delivery that did not land: an
 *  inbound record is what someone else sent us, and re-firing a delivered
 *  webhook would duplicate an event the receiver already acted on. */
function canReplayDelivery(delivery: WebhookDelivery): boolean {
  return (
    delivery.direction === "outbound" &&
    (delivery.status === "failed" || delivery.status === "abandoned")
  );
}

export function DeliveriesPanel({
  deliveries,
  filters,
  isLoading,
  selectedDelivery,
  setFilters,
  setSelectedDelivery,
  webhookNames,
  onReplay,
  isReplaying,
}: {
  readonly deliveries: readonly WebhookDelivery[];
  readonly filters: Required<DeliveryFilterState>;
  readonly isLoading: boolean;
  readonly selectedDelivery: WebhookDelivery | null;
  readonly setFilters: (filters: Required<DeliveryFilterState>) => void;
  readonly setSelectedDelivery: (delivery: WebhookDelivery | null) => void;
  /** Endpoint id -> name, so a row can say "Billing sync" instead of a UUID. */
  readonly webhookNames: ReadonlyMap<string, string>;
  readonly onReplay: (deliveryId: string) => void;
  readonly isReplaying: boolean;
}) {
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const columns = useMemo<ColumnDef<WebhookDelivery>[]>(
    () => [
      {
        id: "detail",
        header: "Detail",
        cell: ({ row }) => {
          const delivery = row.original;
          return (
            <button
              className="helix-button helix-button-secondary"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedDelivery(delivery);
              }}
              type="button"
            >
              View
            </button>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <DeliveryStatusPill status={row.original.status} />,
      },
      {
        id: "direction",
        header: "Direction",
        cell: ({ row }) => row.original.direction,
      },
      {
        id: "endpoint",
        header: "Endpoint",
        cell: ({ row }) => deliveryEndpointLabel(row.original, webhookNames),
      },
      {
        id: "subject",
        header: "Subject",
        cell: ({ row }) => row.original.eventSubject,
      },
      {
        id: "attempt",
        header: "Attempt",
        cell: ({ row }) => row.original.attempt,
      },
      {
        id: "http",
        header: "HTTP",
        cell: ({ row }) => row.original.responseStatus ?? "-",
      },
      {
        id: "created",
        header: "Created",
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
    ],
    [setSelectedDelivery, webhookNames],
  );
  const data = useMemo(() => [...deliveries], [deliveries]);
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
  });
  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: () => 41,
    overscan: 8,
  });
  const measuredVirtualRows = rowVirtualizer.getVirtualItems();
  const virtualRows =
    measuredVirtualRows.length > 0 || rows.length === 0
      ? measuredVirtualRows
      : rows.slice(0, 20).map((_, index) => ({
          end: (index + 1) * 41,
          index,
          size: 41,
          start: index * 41,
        }));
  const firstVirtualRow = virtualRows[0];
  const lastVirtualRow = virtualRows[virtualRows.length - 1];
  const paddingTop = firstVirtualRow?.start ?? 0;
  const paddingBottom =
    lastVirtualRow === undefined ? 0 : rowVirtualizer.getTotalSize() - lastVirtualRow.end;

  return (
    <div className="webhooks-grid">
      <div className="webhooks-panel">
        <PanelTitle title="Delivery log" detail="Recent webhook attempts" />
        <div className="webhooks-filters">
          <label className="webhooks-field">
            <span>Direction</span>
            <select
              value={filters.direction}
              onChange={(event) =>
                setFilters({ ...filters, direction: event.target.value as "" | WebhookDirection })
              }
            >
              <option value="">All directions</option>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </label>
          <label className="webhooks-field">
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value as "" | WebhookDeliveryStatus })
              }
            >
              <option value="">All statuses</option>
              {webhookDeliveryStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Webhook ID"
            value={filters.webhookId}
            onChange={(value) => setFilters({ ...filters, webhookId: value })}
          />
          <TextField
            label="From"
            type="datetime-local"
            value={filters.createdAfter}
            onChange={(value) => setFilters({ ...filters, createdAfter: value })}
          />
          <TextField
            label="To"
            type="datetime-local"
            value={filters.createdBefore}
            onChange={(value) => setFilters({ ...filters, createdBefore: value })}
          />
          <TextField
            label="Limit"
            type="number"
            value={filters.limit}
            onChange={(value) => setFilters({ ...filters, limit: value })}
          />
        </div>
        <div className="webhooks-table-wrap deliveries" ref={tableWrapRef} tabIndex={0}>
          <table className="webhooks-table" aria-label="Webhook deliveries">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  colSpan={columns.length}
                  text={
                    isLoading ? "Loading deliveries..." : "No deliveries match the current filters."
                  }
                />
              ) : (
                <>
                  {paddingTop > 0 ? (
                    <tr aria-hidden="true">
                      <td colSpan={columns.length} style={{ height: `${String(paddingTop)}px` }} />
                    </tr>
                  ) : null}
                  {virtualRows.map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (row === undefined) {
                      return null;
                    }
                    const delivery = row.original;
                    return (
                      <tr
                        aria-selected={selectedDelivery?.id === delivery.id}
                        className={selectedDelivery?.id === delivery.id ? "selected" : undefined}
                        data-index={virtualRow.index}
                        key={row.id}
                        onClick={() => setSelectedDelivery(delivery)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedDelivery(delivery);
                          }
                        }}
                        tabIndex={0}
                        ref={(node) => {
                          if (node !== null) {
                            rowVirtualizer.measureElement(node);
                          }
                        }}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {paddingBottom > 0 ? (
                    <tr aria-hidden="true">
                      <td
                        colSpan={columns.length}
                        style={{ height: `${String(paddingBottom)}px` }}
                      />
                    </tr>
                  ) : null}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {selectedDelivery !== null ? (
        <aside className="webhooks-editor">
          <EditorTitle
            mode="view"
            title="Delivery detail"
            onCancel={() => setSelectedDelivery(null)}
          />
          <DetailRow label="ID" value={selectedDelivery.id} />
          <DetailRow
            label="Webhook"
            value={deliveryEndpointLabel(selectedDelivery, webhookNames)}
          />
          <DetailRow label="Direction" value={selectedDelivery.direction} />
          <DetailRow label="Status" value={selectedDelivery.status} />
          <DetailRow
            label="Response status"
            value={String(selectedDelivery.responseStatus ?? "-")}
          />
          <DetailRow label="Payload SHA-256" value={selectedDelivery.payloadSha256 ?? "-"} />
          <DetailRow label="Error" value={selectedDelivery.error ?? "-"} />
          {canReplayDelivery(selectedDelivery) ? (
            <div className="webhooks-row-actions">
              <button
                className="helix-button"
                disabled={isReplaying}
                onClick={() => {
                  onReplay(selectedDelivery.id);
                }}
                type="button"
              >
                {isReplaying ? "Replaying…" : "Replay delivery"}
              </button>
              <button
                className="helix-button helix-button-secondary"
                onClick={() => {
                  /* Jump straight from one failure to that endpoint's whole
                     history — the question after "this failed" is almost always
                     "is it only this one?". */
                  const id = selectedDelivery.outboundWebhookId;
                  if (id !== null) {
                    setFilters({ ...filters, direction: "outbound", webhookId: id, status: "" });
                  }
                }}
                type="button"
              >
                Show this endpoint
              </button>
            </div>
          ) : null}
          <pre>
            {JSON.stringify(
              {
                payload: selectedDelivery.payload,
                request: {
                  headers: selectedDelivery.requestHeaders,
                  signature: selectedDelivery.signature,
                },
                response: {
                  status: selectedDelivery.responseStatus,
                  headers: selectedDelivery.responseHeaders,
                  error: selectedDelivery.error,
                  deliveredAt: selectedDelivery.deliveredAt,
                  nextAttemptAt: selectedDelivery.nextAttemptAt,
                },
              },
              null,
              2,
            )}
          </pre>
        </aside>
      ) : null}
    </div>
  );
}

export function isWebhookDirection(value: string): value is WebhookDirection {
  return value === "outbound" || value === "inbound";
}

export function isWebhookDeliveryStatus(value: string): value is WebhookDeliveryStatus {
  return webhookDeliveryStatuses.includes(value as WebhookDeliveryStatus);
}

export function dateTimeFilterToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
