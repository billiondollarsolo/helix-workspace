import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Pencil, Play, RotateCw, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { InboundWebhook, OutboundWebhook, WebhookDirection } from "./types";
import { EmptyRow, PanelTitle, RowActions, StatusPill } from "./webhook-controls";
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
  readonly detailColumns: readonly ColumnDef<Row>[];
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
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusPill enabled={row.original.enabled} />,
      },
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <small>{shortId(row.original.id)}</small>
          </>
        ),
      },
      ...detailColumns,
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const webhook = row.original;
          return (
            <RowActions>
              <button
                className="icon-button"
                disabled={isBusy}
                onClick={() => onEdit(webhook)}
                title="Edit"
                type="button"
              >
                <Pencil aria-hidden="true" size={15} />
              </button>
              <button
                className="icon-button"
                disabled={isBusy}
                onClick={() => onAction({ type: "toggle", webhook })}
                title={webhook.enabled ? "Disable" : "Enable"}
                type="button"
              >
                {webhook.enabled ? "Off" : "On"}
              </button>
              <button
                className="icon-button"
                disabled={isBusy || !webhook.enabled}
                onClick={() => onAction({ type: "test", webhook })}
                title={testTitle}
                type="button"
              >
                <Play aria-hidden="true" size={15} />
              </button>
              <button
                className="icon-button"
                disabled={isBusy}
                onClick={() => onAction({ type: "rotate", webhook })}
                title={rotateTitle}
                type="button"
              >
                <RotateCw aria-hidden="true" size={15} />
              </button>
              {pendingDelete === webhook.id ? (
                <button
                  className="webhooks-confirm-delete"
                  disabled={isBusy}
                  onClick={() => onAction({ type: "delete", webhook })}
                  type="button"
                >
                  Delete
                </button>
              ) : (
                <button
                  className="icon-button danger"
                  disabled={isBusy}
                  onClick={() => setPendingDelete(webhook.id)}
                  title="Delete"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
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
  const data = useMemo(() => [...webhooks], [webhooks]);
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
  });
  const rows = table.getRowModel().rows;

  return (
    <div className="webhooks-panel">
      <PanelTitle title={title} detail={detail} />
      <div className="webhooks-table-wrap" tabIndex={0}>
        <table className="webhooks-table" aria-label={ariaLabel}>
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
                text={webhookTableEmptyText(emptyText, isBusy, failed)}
              />
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
  const detailColumns = useMemo<ColumnDef<OutboundWebhook>[]>(
    () => [
      {
        id: "url",
        header: "URL",
        cell: ({ row }) => <code className="webhooks-url">{row.original.url}</code>,
      },
      {
        id: "subjects",
        header: "Subjects",
        cell: ({ row }) =>
          row.original.eventSubjects.length > 0
            ? row.original.eventSubjects.join(", ")
            : "All events",
      },
      {
        id: "format",
        header: "Format",
        cell: ({ row }) => stringMetadata(row.original.metadata, "format") ?? "generic",
      },
      {
        id: "updated",
        header: "Updated",
        cell: ({ row }) => formatDate(row.original.updatedAt),
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
  const detailColumns = useMemo<ColumnDef<InboundWebhook>[]>(
    () => [
      {
        id: "endpoint",
        header: "Endpoint",
        cell: ({ row }) => <code className="webhooks-url">/v1/webhooks/{row.original.slug}</code>,
      },
      {
        id: "source",
        header: "Source",
        cell: ({ row }) => row.original.source,
      },
      {
        id: "action",
        header: "Action",
        cell: ({ row }) => actionLabel(row.original.metadata),
      },
      {
        id: "lastReceived",
        header: "Last received",
        cell: ({ row }) => formatDate(row.original.lastReceivedAt),
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
