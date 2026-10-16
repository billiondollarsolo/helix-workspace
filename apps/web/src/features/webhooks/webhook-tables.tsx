import { Button } from "@/components/ui/button";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { Pencil, Play, RotateCw, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { InboundWebhook, OutboundWebhook, WebhookDirection } from "./types";
import { PanelTitle, RowActions, StatusPill } from "./webhook-controls";
import { actionLabel, stringMetadata } from "./webhook-form-state";
import { formatDate, shortId } from "./webhook-format";

/* Both directions offer the same four row buttons, and every one of them carries
   the same payload — the row it was pressed on. This was two four-member unions
   whose members differed only in the literal `type`, which is a discriminant
   with nothing to discriminate. */
type WebhookRowActionType = "toggle" | "test" | "rotate" | "delete";

export interface WebhookRowAction<Webhook> {
  readonly type: WebhookRowActionType;
  readonly webhook: Webhook;
}

export type OutboundRowAction = WebhookRowAction<OutboundWebhook>;

export type InboundRowAction = WebhookRowAction<InboundWebhook>;

/** What a row needs to carry for the shared Status column and action buttons to
 *  mean anything, whichever direction the row came from. */
interface WebhookTableRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/** The three words a table calls itself when it has no rows to show. Which one
 *  the operator sees is the difference between "nothing is configured here" and
 *  "we could not find out", so each direction spells out its own. */
interface WebhookTableEmptyText {
  readonly loading: string;
  readonly failed: string;
  readonly empty: string;
}

function webhookTableEmptyText(
  text: WebhookTableEmptyText,
  isBusy: boolean,
  failed: boolean,
): string {
  if (isBusy) {
    return text.loading;
  }
  return failed ? text.failed : text.empty;
}

/** What the section hands a direction table: the same seven props either way,
 *  which is why `OutboundTable` and `InboundTable` can forward them untouched. */
interface WebhookTableProps<Webhook> {
  /** The list request failed, so an empty table is not an empty workspace. */
  readonly failed: boolean;
  readonly isBusy: boolean;
  readonly onAction: (action: WebhookRowAction<Webhook>) => void;
  readonly onEdit: (webhook: Webhook) => void;
  readonly pendingDelete: string | null;
  readonly setPendingDelete: (id: string | null) => void;
  readonly webhooks: readonly Webhook[];
}

/** The half that is fixed per direction: the wording the shared table wears,
 *  and the columns only that direction has. */
interface WebhookTableShape<Row> {
  readonly ariaLabel: string;
  readonly detail: string;
  /** Direction-specific columns, rendered between Name and Actions. */
  readonly detailColumns: readonly AdminColumn<Row>[];
  readonly emptyText: WebhookTableEmptyText;
  readonly rotateTitle: string;
  readonly testTitle: string;
  readonly title: string;
}

/* Outbound and inbound endpoints are the same table with a different middle:
   both open on Status and Name, both close on the same five row buttons, and
   only the columns in between describe something direction-specific. Those
   columns arrive as `detailColumns`; the two verbs that differ on the shared
   buttons ("Test fire" against "Test verify", and which secret is being
   rotated) arrive as their own props rather than being derived from a
   direction flag, so the wording stays visible at the call site. */
function WebhookTable<Row extends WebhookTableRow>({
  ariaLabel,
  detail,
  detailColumns,
  emptyText,
  failed,
  isBusy,
  onAction,
  onEdit,
  pendingDelete,
  rotateTitle,
  setPendingDelete,
  testTitle,
  title,
  webhooks,
}: WebhookTableProps<Row> & WebhookTableShape<Row>) {
  const columns = useMemo<AdminColumn<Row>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        sortValue: (row) => (row.enabled ? "Enabled" : "Disabled"),
        cell: (row) => <StatusPill enabled={row.enabled} />,
      },
      {
        id: "name",
        header: "Name",
        sortValue: (row) => row.name,
        cell: (row) => (
          <>
            <strong>{row.name}</strong>
            <small>{shortId(row.id)}</small>
          </>
        ),
      },
      ...detailColumns,
      {
        id: "actions",
        header: "Actions",
        cell: (row) => {
          const webhook = row;
          return (
            <RowActions>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isBusy}
                onClick={() => onEdit(webhook)}
                title="Edit"
                type="button"
              >
                <Pencil aria-hidden="true" size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isBusy}
                onClick={() => onAction({ type: "toggle", webhook })}
                title={webhook.enabled ? "Disable" : "Enable"}
                type="button"
              >
                {webhook.enabled ? "Off" : "On"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isBusy || !webhook.enabled}
                onClick={() => onAction({ type: "test", webhook })}
                title={testTitle}
                type="button"
              >
                <Play aria-hidden="true" size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isBusy}
                onClick={() => onAction({ type: "rotate", webhook })}
                title={rotateTitle}
                type="button"
              >
                <RotateCw aria-hidden="true" size={15} />
              </Button>
              {pendingDelete === webhook.id ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onAction({ type: "delete", webhook })}
                  type="button"
                >
                  Delete
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  disabled={isBusy}
                  onClick={() => setPendingDelete(webhook.id)}
                  title="Delete"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </Button>
              )}
            </RowActions>
          );
        },
      },
    ],
    [
      detailColumns,
      isBusy,
      onAction,
      onEdit,
      pendingDelete,
      rotateTitle,
      setPendingDelete,
      testTitle,
    ],
  );
  return (
    <div className="webhooks-panel">
      <PanelTitle title={title} detail={detail} />
      <AdminTable
        label={ariaLabel}
        columns={columns}
        rows={webhooks}
        rowKey={(row) => row.id}
        searchText={(row) =>
          [row.id, ...columns.map((column) => column.sortValue?.(row))].join(" ")
        }
        partialNote="Search and sorting apply to the returned endpoints."
        empty={webhookTableEmptyText(emptyText, isBusy, failed)}
      />
    </div>
  );
}

const outboundEmptyText: WebhookTableEmptyText = {
  loading: "Loading outbound webhooks...",
  failed: "Could not load outbound webhooks.",
  empty: "No outbound webhooks configured.",
};

const inboundEmptyText: WebhookTableEmptyText = {
  loading: "Loading inbound webhooks...",
  failed: "Could not load inbound receivers.",
  empty: "No inbound receivers configured.",
};

export function OutboundTable(props: WebhookTableProps<OutboundWebhook>) {
  const detailColumns = useMemo<AdminColumn<OutboundWebhook>[]>(
    () => [
      {
        id: "url",
        header: "URL",
        sortValue: (row) => row.url,
        cell: (row) => <code className="webhooks-url">{row.url}</code>,
      },
      {
        id: "subjects",
        header: "Subjects",
        sortValue: (row) => row.eventSubjects.join(" "),
        cell: (row) => (row.eventSubjects.length > 0 ? row.eventSubjects.join(", ") : "All events"),
      },
      {
        id: "format",
        header: "Format",
        sortValue: (row) => stringMetadata(row.metadata, "format") ?? "generic",
        cell: (row) => stringMetadata(row.metadata, "format") ?? "generic",
      },
      {
        id: "updated",
        header: "Updated",
        sortValue: (row) => new Date(row.updatedAt).getTime(),
        cell: (row) => formatDate(row.updatedAt),
      },
    ],
    [],
  );

  return (
    <WebhookTable
      {...props}
      ariaLabel="Outbound webhooks"
      detail="Helix to external systems"
      detailColumns={detailColumns}
      emptyText={outboundEmptyText}
      rotateTitle="Rotate signing secret"
      testTitle="Test fire"
      title="Outbound webhooks"
    />
  );
}

export function InboundTable(props: WebhookTableProps<InboundWebhook>) {
  const detailColumns = useMemo<AdminColumn<InboundWebhook>[]>(
    () => [
      {
        id: "endpoint",
        header: "Endpoint",
        sortValue: (row) => row.slug,
        cell: (row) => <code className="webhooks-url">/v1/webhooks/{row.slug}</code>,
      },
      {
        id: "source",
        header: "Source",
        sortValue: (row) => row.source,
        cell: (row) => row.source,
      },
      {
        id: "action",
        header: "Action",
        sortValue: (row) => actionLabel(row.metadata),
        cell: (row) => actionLabel(row.metadata),
      },
      {
        id: "lastReceived",
        header: "Last received",
        sortValue: (row) =>
          row.lastReceivedAt === null ? null : new Date(row.lastReceivedAt).getTime(),
        cell: (row) => formatDate(row.lastReceivedAt),
      },
    ],
    [],
  );

  return (
    <WebhookTable
      {...props}
      ariaLabel="Inbound webhooks"
      detail="External systems to Helix"
      detailColumns={detailColumns}
      emptyText={inboundEmptyText}
      rotateTitle="Rotate secret"
      testTitle="Test verify"
      title="Inbound webhooks"
    />
  );
}

/* Every one of these was its own `if` in one of two near-identical functions.
   The wording genuinely differs per direction — an outbound test is fired, an
   inbound one is verified — so both columns are spelled out rather than built
   from a direction word. */
export const webhookActionLabels: Record<WebhookDirection, Record<WebhookRowActionType, string>> = {
  outbound: {
    toggle: "Outbound webhook updated",
    test: "Outbound test fired",
    rotate: "Outbound signing secret rotated",
    delete: "Outbound webhook deleted",
  },
  inbound: {
    toggle: "Inbound webhook updated",
    test: "Inbound test verified",
    rotate: "Inbound secret rotated",
    delete: "Inbound webhook deleted",
  },
};
