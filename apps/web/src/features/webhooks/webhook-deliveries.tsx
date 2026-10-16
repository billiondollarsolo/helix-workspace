import { Button } from "@/components/ui/button";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { useMemo } from "react";
import type { WebhookDeliveryListInput } from "./api";
import { webhookDeliveryStatuses } from "./api";
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookDirection } from "./types";
import {
  DeliveryStatusPill,
  DetailRow,
  EditorTitle,
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
  /** Endpoint id -> name, so a row can say "CRM sync" instead of a UUID. */
  readonly webhookNames: ReadonlyMap<string, string>;
  readonly onReplay: (deliveryId: string) => void;
  readonly isReplaying: boolean;
}) {
  const columns = useMemo<AdminColumn<WebhookDelivery>[]>(
    () => [
      {
        id: "detail",
        header: "Detail",
        cell: (row) => {
          const delivery = row;
          return (
            <Button
              variant="outline"
              size="sm"
              aria-label={`View delivery ${delivery.id}`}
              aria-pressed={selectedDelivery?.id === delivery.id}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedDelivery(delivery);
              }}
              type="button"
            >
              View
            </Button>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status,
        cell: (row) => <DeliveryStatusPill status={row.status} />,
      },
      {
        id: "direction",
        header: "Direction",
        sortValue: (row) => row.direction,
        cell: (row) => row.direction,
      },
      {
        id: "endpoint",
        header: "Endpoint",
        sortValue: (row) => deliveryEndpointLabel(row, webhookNames),
        cell: (row) => deliveryEndpointLabel(row, webhookNames),
      },
      {
        id: "subject",
        header: "Subject",
        sortValue: (row) => row.eventSubject,
        cell: (row) => row.eventSubject,
      },
      {
        id: "attempt",
        header: "Attempt",
        sortValue: (row) => row.attempt,
        cell: (row) => row.attempt,
      },
      {
        id: "http",
        header: "HTTP",
        sortValue: (row) => row.responseStatus,
        cell: (row) => row.responseStatus ?? "-",
      },
      {
        id: "created",
        header: "Created",
        sortValue: (row) => new Date(row.createdAt).getTime(),
        cell: (row) => formatDate(row.createdAt),
      },
    ],
    [setSelectedDelivery, webhookNames, selectedDelivery?.id],
  );
  return (
    <div className="webhooks-grid">
      <div className="webhooks-panel">
        <PanelTitle title="Delivery log" detail="Recent webhook attempts" />
        <div className="webhooks-filters">
          <label className="webhooks-field">
            <span>Direction</span>
            <select
              className="select"
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
              className="select"
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
        <AdminTable
          label="Webhook deliveries"
          columns={columns}
          rows={deliveries}
          rowKey={(row) => row.id}
          searchText={(row) =>
            [
              row.id,
              row.eventSubject,
              row.status,
              row.direction,
              deliveryEndpointLabel(row, webhookNames),
            ].join(" ")
          }
          partialNote="Search and sorting apply to loaded deliveries. Use the filters above to query other dates or endpoints."
          empty={isLoading ? "Loading deliveries..." : "No deliveries match the current filters."}
        />
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
              <Button
                size="sm"
                disabled={isReplaying}
                onClick={() => {
                  onReplay(selectedDelivery.id);
                }}
                type="button"
              >
                {isReplaying ? "Replaying…" : "Replay delivery"}
              </Button>
              <Button
                variant="outline"
                size="sm"
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
              </Button>
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
