import {
  Activity,
  Copy,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { LucideIcon } from "lucide-react";
import {
  createInboundWebhook,
  createOutboundWebhook,
  deleteInboundWebhook,
  deleteOutboundWebhook,
  generateInlineSecretRef,
  inboundWebhooksQueryOptions,
  outboundWebhooksQueryOptions,
  rotateInboundSecret,
  testInboundWebhook,
  testOutboundWebhook,
  updateInboundWebhook,
  updateOutboundWebhook,
  webhookDeliveriesQueryOptions,
  webhookDeliveryStatuses,
  webhookQueryKeys,
} from "./api";
import type { WebhookDeliveryListInput } from "./api";
import type {
  InboundWebhook,
  OutboundWebhook,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookDirection,
} from "./types";

type WebhookTab = "outbound" | "inbound" | "deliveries";
type OutboundEditorStep = "destination" | "payload" | "review";
type InboundEditorStep = "receiver" | "action" | "review";

interface OutboundFormState {
  readonly mode: "create" | "edit";
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: string;
  readonly enabled: boolean;
  readonly format: string;
  readonly template: string;
  readonly headersJson: string;
  readonly metadataJson: string;
}

interface InboundFormState {
  readonly mode: "create" | "edit";
  readonly id?: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly actionToolId: string;
  readonly actionScopes: string;
  readonly actionInputJson: string;
  readonly metadataJson: string;
}

const outboundFormats = ["generic", "slack", "discord", "teams", "custom"] as const;
const inboundSources = [
  "generic",
  "github",
  "gitlab",
  "stripe",
  "linear",
  "grafana",
  "prometheus",
] as const;

const webhookNameSchema = z.string().trim().min(1, "Name is required.");
const outboundUrlSchema = z
  .string()
  .refine(isValidHttpUrl, "Destination URL must be a valid HTTP or HTTPS URL.");
const outboundEventSubjectsSchema = z.string();
const outboundFormatSchema = z.enum(outboundFormats);
const outboundTemplateSchema = z.string();
const outboundHeadersJsonSchema = jsonRecordFieldSchema("Headers JSON").superRefine(
  (value, context) => {
    let parsedHeaders: Record<string, unknown>;
    try {
      parsedHeaders = parseJsonRecord(value);
    } catch {
      return;
    }
    if (Object.values(parsedHeaders).some((headerValue) => typeof headerValue !== "string")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Headers JSON values must be strings.",
      });
    }
  },
);
const metadataJsonSchema = jsonRecordFieldSchema("Metadata JSON");
const webhookEnabledSchema = z.boolean();
const inboundSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/u,
    "Slug must start with a lowercase letter or number and use only lowercase letters, numbers, and hyphens.",
  );
const inboundSourceSchema = z.enum(inboundSources);
const inboundActionToolIdSchema = z.string();
const inboundActionScopesSchema = z.string();
const inboundActionInputJsonSchema = z.string().superRefine((value, context) => {
  if (value.trim() === "") {
    return;
  }
  try {
    JSON.parse(value) as unknown;
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Action input JSON is invalid: ${errorMessage(error)}`,
    });
  }
});

const outboundEditorSteps: readonly {
  readonly id: OutboundEditorStep;
  readonly label: string;
}[] = [
  { id: "destination", label: "Destination" },
  { id: "payload", label: "Payload" },
  { id: "review", label: "Review" },
];

const inboundEditorSteps: readonly {
  readonly id: InboundEditorStep;
  readonly label: string;
}[] = [
  { id: "receiver", label: "Receiver" },
  { id: "action", label: "Action" },
  { id: "review", label: "Review" },
];

const emptyOutboundForm: OutboundFormState = {
  mode: "create",
  name: "",
  url: "",
  eventSubjects: "platform.pending_action.created",
  enabled: true,
  format: "generic",
  template: "",
  headersJson: "{}",
  metadataJson: "{}",
};

const emptyInboundForm: InboundFormState = {
  mode: "create",
  name: "",
  slug: "",
  source: "generic",
  enabled: true,
  actionToolId: "",
  actionScopes: "admin.webhooks",
  actionInputJson: "",
  metadataJson: "{}",
};

export function WebhookManagement() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<WebhookTab>("outbound");
  const [outboundForm, setOutboundForm] = useState<OutboundFormState | null>(null);
  const [inboundForm, setInboundForm] = useState<InboundFormState | null>(null);
  const [deliveryFilters, setDeliveryFilters] = useState<Required<DeliveryFilterState>>({
    direction: "",
    status: "",
    webhookId: "",
    createdAfter: "",
    createdBefore: "",
    limit: "100",
  });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDelivery | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  const deliveryInput = useMemo<WebhookDeliveryListInput>(() => {
    const limit = Number(deliveryFilters.limit);
    const createdAfter = dateTimeFilterToIso(deliveryFilters.createdAfter);
    const createdBefore = dateTimeFilterToIso(deliveryFilters.createdBefore);
    return {
      ...(isWebhookDirection(deliveryFilters.direction)
        ? { direction: deliveryFilters.direction }
        : {}),
      ...(isWebhookDeliveryStatus(deliveryFilters.status)
        ? { status: deliveryFilters.status }
        : {}),
      ...(deliveryFilters.webhookId.trim().length > 0
        ? { webhookId: deliveryFilters.webhookId.trim() }
        : {}),
      ...(createdAfter === null ? {} : { createdAfter }),
      ...(createdBefore === null ? {} : { createdBefore }),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
    };
  }, [deliveryFilters]);

  const outboundQuery = useQuery(outboundWebhooksQueryOptions());
  const inboundQuery = useQuery(inboundWebhooksQueryOptions());
  const deliveriesQuery = useQuery(webhookDeliveriesQueryOptions(deliveryInput));

  const outboundMutation = useMutation({
    mutationFn: async (form: OutboundFormState) => {
      const input = outboundInputFromForm(form);
      if (form.mode === "edit" && form.id !== undefined) {
        return updateOutboundWebhook({ id: form.id, ...input });
      }
      return createOutboundWebhook(input);
    },
    onMutate: async (form) => {
      await cancelWebhookQueries(queryClient);
      const context = snapshotWebhookQueries(queryClient);
      queryClient.setQueryData<readonly OutboundWebhook[]>(webhookQueryKeys.outbound, (current) =>
        optimisticOutboundSave(current, form),
      );
      return context;
    },
    onSuccess: async () => {
      setOutboundForm(null);
      await invalidateWebhookQueries(queryClient);
      toast.success("Outbound webhook saved");
    },
    onError: (error, _form, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const inboundMutation = useMutation({
    mutationFn: async (form: InboundFormState) => {
      const input = inboundInputFromForm(form);
      if (form.mode === "edit" && form.id !== undefined) {
        return updateInboundWebhook({ id: form.id, ...input });
      }
      return createInboundWebhook(input);
    },
    onMutate: async (form) => {
      await cancelWebhookQueries(queryClient);
      const context = snapshotWebhookQueries(queryClient);
      queryClient.setQueryData<readonly InboundWebhook[]>(webhookQueryKeys.inbound, (current) =>
        optimisticInboundSave(current, form),
      );
      return context;
    },
    onSuccess: async () => {
      setInboundForm(null);
      await invalidateWebhookQueries(queryClient);
      toast.success("Inbound webhook saved");
    },
    onError: (error, _form, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await invalidateWebhookQueries(queryClient);
    },
    onMutate: async () => {
      await cancelWebhookQueries(queryClient);
      return snapshotWebhookQueries(queryClient);
    },
    onSuccess: () => toast.success("Webhook data refreshed"),
    onError: (error, _variables, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const outboundActionMutation = useMutation({
    mutationFn: async (action: OutboundRowAction) => {
      if (action.type === "delete") {
        return deleteOutboundWebhook(action.webhook.id);
      }
      if (action.type === "test") {
        return testOutboundWebhook(action.webhook.id);
      }
      if (action.type === "rotate") {
        return updateOutboundWebhook({
          id: action.webhook.id,
          secretRef: generateInlineSecretRef(),
        });
      }
      return updateOutboundWebhook({ id: action.webhook.id, enabled: !action.webhook.enabled });
    },
    onMutate: async (action) => {
      await cancelWebhookQueries(queryClient);
      const context = snapshotWebhookQueries(queryClient);
      queryClient.setQueryData<readonly OutboundWebhook[]>(webhookQueryKeys.outbound, (current) =>
        optimisticOutboundAction(current, action),
      );
      return context;
    },
    onSuccess: async (_output, action) => {
      setPendingDelete(null);
      await invalidateWebhookQueries(queryClient);
      toast.success(outboundActionLabel(action.type));
    },
    onError: (error, _action, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const inboundActionMutation = useMutation({
    mutationFn: async (action: InboundRowAction) => {
      if (action.type === "delete") {
        return deleteInboundWebhook(action.webhook.id);
      }
      if (action.type === "rotate") {
        return rotateInboundSecret(action.webhook.id);
      }
      if (action.type === "test") {
        return testInboundWebhook(action.webhook);
      }
      return updateInboundWebhook({ id: action.webhook.id, enabled: !action.webhook.enabled });
    },
    onMutate: async (action) => {
      await cancelWebhookQueries(queryClient);
      const context = snapshotWebhookQueries(queryClient);
      queryClient.setQueryData<readonly InboundWebhook[]>(webhookQueryKeys.inbound, (current) =>
        optimisticInboundAction(current, action),
      );
      return context;
    },
    onSuccess: async (output, action) => {
      setPendingDelete(null);
      if (action.type === "rotate" && isRotateOutput(output)) {
        setRotatedSecret(output.secretRef);
      }
      await invalidateWebhookQueries(queryClient);
      toast.success(inboundActionLabel(action.type));
    },
    onError: (error, _action, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const outboundWebhooks = outboundQuery.data ?? [];
  const inboundWebhooks = inboundQuery.data ?? [];
  const deliveries = deliveriesQuery.data ?? [];

  return (
    <section className="webhooks-page" aria-labelledby="webhooks-title">
      <header className="webhooks-header">
        <div>
          <p className="webhooks-kicker">Admin</p>
          <h1 id="webhooks-title">Webhooks</h1>
          <p>Manage outbound endpoints, inbound receivers, and delivery history.</p>
        </div>
        <div className="webhooks-header-actions">
          <button
            className="helix-button helix-button-secondary"
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
            Refresh
          </button>
          <button
            className="helix-button"
            onClick={() => {
              setActiveTab("outbound");
              setOutboundForm(emptyOutboundForm);
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            Outbound
          </button>
          <button
            className="helix-button"
            onClick={() => {
              setActiveTab("inbound");
              setInboundForm(emptyInboundForm);
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            Inbound
          </button>
        </div>
      </header>

      <div className="webhooks-summary" aria-label="Webhook summary">
        <SummaryMetric label="Outbound" value={outboundWebhooks.length} />
        <SummaryMetric label="Inbound" value={inboundWebhooks.length} />
        <SummaryMetric
          label="Enabled"
          value={
            outboundWebhooks.filter((item) => item.enabled).length +
            inboundWebhooks.filter((item) => item.enabled).length
          }
        />
        <SummaryMetric
          label="Failed deliveries"
          value={deliveries.filter((item) => item.status === "failed").length}
          tone="danger"
        />
      </div>

      <div className="webhooks-tabs" role="tablist" aria-label="Webhook sections">
        <TabButton
          activeTab={activeTab}
          icon={Webhook}
          label="Outbound"
          tab="outbound"
          setActiveTab={setActiveTab}
        />
        <TabButton
          activeTab={activeTab}
          icon={Webhook}
          label="Inbound"
          tab="inbound"
          setActiveTab={setActiveTab}
        />
        <TabButton
          activeTab={activeTab}
          icon={Activity}
          label="Deliveries"
          tab="deliveries"
          setActiveTab={setActiveTab}
        />
      </div>

      {rotatedSecret !== null ? (
        <div className="webhooks-secret-banner" role="status">
          <span>Rotated inbound secret</span>
          <code>{rotatedSecret}</code>
          <button
            className="icon-button"
            onClick={() => void copyText(rotatedSecret)}
            title="Copy secret"
            type="button"
          >
            <Copy aria-hidden="true" size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => setRotatedSecret(null)}
            title="Dismiss"
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      ) : null}

      <QueryErrors errors={[outboundQuery.error, inboundQuery.error, deliveriesQuery.error]} />

      {activeTab === "outbound" ? (
        <div className="webhooks-grid">
          <OutboundTable
            isBusy={outboundQuery.isLoading || outboundActionMutation.isPending}
            onAction={(action) => outboundActionMutation.mutate(action)}
            onEdit={(webhook) => setOutboundForm(outboundFormFromWebhook(webhook))}
            pendingDelete={pendingDelete}
            setPendingDelete={setPendingDelete}
            webhooks={outboundWebhooks}
          />
          {outboundForm !== null ? (
            <OutboundForm
              form={outboundForm}
              isSaving={outboundMutation.isPending}
              key={formKey(outboundForm)}
              onCancel={() => setOutboundForm(null)}
              onSubmit={(form) => outboundMutation.mutate(form)}
            />
          ) : null}
        </div>
      ) : null}

      {activeTab === "inbound" ? (
        <div className="webhooks-grid">
          <InboundTable
            isBusy={inboundQuery.isLoading || inboundActionMutation.isPending}
            onAction={(action) => inboundActionMutation.mutate(action)}
            onEdit={(webhook) => setInboundForm(inboundFormFromWebhook(webhook))}
            pendingDelete={pendingDelete}
            setPendingDelete={setPendingDelete}
            webhooks={inboundWebhooks}
          />
          {inboundForm !== null ? (
            <InboundForm
              form={inboundForm}
              isSaving={inboundMutation.isPending}
              key={formKey(inboundForm)}
              onCancel={() => setInboundForm(null)}
              onSubmit={(form) => inboundMutation.mutate(form)}
            />
          ) : null}
        </div>
      ) : null}

      {activeTab === "deliveries" ? (
        <DeliveriesPanel
          deliveries={deliveries}
          filters={deliveryFilters}
          isLoading={deliveriesQuery.isLoading}
          selectedDelivery={selectedDelivery}
          setFilters={setDeliveryFilters}
          setSelectedDelivery={setSelectedDelivery}
        />
      ) : null}
    </section>
  );
}

interface DeliveryFilterState {
  readonly direction: "" | WebhookDirection;
  readonly status: "" | WebhookDeliveryStatus;
  readonly webhookId: string;
  readonly createdAfter: string;
  readonly createdBefore: string;
  readonly limit: string;
}

type OutboundRowAction =
  | { readonly type: "toggle"; readonly webhook: OutboundWebhook }
  | { readonly type: "test"; readonly webhook: OutboundWebhook }
  | { readonly type: "rotate"; readonly webhook: OutboundWebhook }
  | { readonly type: "delete"; readonly webhook: OutboundWebhook };

type InboundRowAction =
  | { readonly type: "toggle"; readonly webhook: InboundWebhook }
  | { readonly type: "test"; readonly webhook: InboundWebhook }
  | { readonly type: "rotate"; readonly webhook: InboundWebhook }
  | { readonly type: "delete"; readonly webhook: InboundWebhook };

function SummaryMetric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: "danger";
}) {
  return (
    <div className={tone === "danger" ? "webhooks-summary-item danger" : "webhooks-summary-item"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TabButton({
  activeTab,
  icon: Icon,
  label,
  tab,
  setActiveTab,
}: {
  readonly activeTab: WebhookTab;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tab: WebhookTab;
  readonly setActiveTab: (tab: WebhookTab) => void;
}) {
  return (
    <button
      aria-selected={activeTab === tab}
      className={activeTab === tab ? "webhooks-tab active" : "webhooks-tab"}
      onClick={() => setActiveTab(tab)}
      role="tab"
      type="button"
    >
      <Icon aria-hidden="true" size={16} />
      {label}
    </button>
  );
}

function QueryErrors({ errors }: { readonly errors: readonly (Error | null)[] }) {
  const visibleErrors = errors.filter((error): error is Error => error !== null);
  if (visibleErrors.length === 0) {
    return null;
  }
  return (
    <div className="webhooks-error-panel" role="alert">
      <strong>Webhook API unavailable</strong>
      <span>{visibleErrors[0]?.message ?? "Unable to load webhook data."}</span>
    </div>
  );
}

function OutboundTable({
  isBusy,
  onAction,
  onEdit,
  pendingDelete,
  setPendingDelete,
  webhooks,
}: {
  readonly isBusy: boolean;
  readonly onAction: (action: OutboundRowAction) => void;
  readonly onEdit: (webhook: OutboundWebhook) => void;
  readonly pendingDelete: string | null;
  readonly setPendingDelete: (id: string | null) => void;
  readonly webhooks: readonly OutboundWebhook[];
}) {
  const columns = useMemo<ColumnDef<OutboundWebhook>[]>(
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
                title="Test fire"
                type="button"
              >
                <Play aria-hidden="true" size={15} />
              </button>
              <button
                className="icon-button"
                disabled={isBusy}
                onClick={() => onAction({ type: "rotate", webhook })}
                title="Rotate signing secret"
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
    [isBusy, onAction, onEdit, pendingDelete, setPendingDelete],
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
      <PanelTitle title="Outbound webhooks" detail="Helix to external systems" />
      <div className="webhooks-table-wrap" tabIndex={0}>
        <table className="webhooks-table">
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
                text={isBusy ? "Loading outbound webhooks..." : "No outbound webhooks configured."}
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

function InboundTable({
  isBusy,
  onAction,
  onEdit,
  pendingDelete,
  setPendingDelete,
  webhooks,
}: {
  readonly isBusy: boolean;
  readonly onAction: (action: InboundRowAction) => void;
  readonly onEdit: (webhook: InboundWebhook) => void;
  readonly pendingDelete: string | null;
  readonly setPendingDelete: (id: string | null) => void;
  readonly webhooks: readonly InboundWebhook[];
}) {
  const columns = useMemo<ColumnDef<InboundWebhook>[]>(
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
      {
        id: "endpoint",
        header: "Endpoint",
        cell: ({ row }) => <code className="webhooks-url">/webhooks/{row.original.slug}</code>,
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
                title="Test verify"
                type="button"
              >
                <Play aria-hidden="true" size={15} />
              </button>
              <button
                className="icon-button"
                disabled={isBusy}
                onClick={() => onAction({ type: "rotate", webhook })}
                title="Rotate secret"
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
    [isBusy, onAction, onEdit, pendingDelete, setPendingDelete],
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
      <PanelTitle title="Inbound webhooks" detail="External systems to Helix" />
      <div className="webhooks-table-wrap" tabIndex={0}>
        <table className="webhooks-table">
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
                text={isBusy ? "Loading inbound webhooks..." : "No inbound receivers configured."}
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

function OutboundForm({
  form,
  isSaving,
  onCancel,
  onSubmit,
}: {
  readonly form: OutboundFormState;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (form: OutboundFormState) => void;
}) {
  const [step, setStep] = useState<OutboundEditorStep>("destination");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editorForm = useForm({
    defaultValues: form,
    onSubmit: ({ value }) => {
      const validationError = validateOutboundForm(value);
      if (validationError !== null) {
        setSubmitError(validationError.message);
        setStep(validationError.step);
        return;
      }
      setSubmitError(null);
      onSubmit(value);
    },
  });
  const stepIndex = outboundEditorSteps.findIndex((item) => item.id === step);

  return (
    <form
      className="webhooks-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void editorForm.handleSubmit();
      }}
    >
      <EditorTitle mode={form.mode} title="outbound webhook" onCancel={onCancel} />
      <EditorSteps
        activeStep={step}
        ariaLabel="Outbound webhook setup steps"
        onStepChange={setStep}
        steps={outboundEditorSteps}
      />
      {submitError !== null ? <FormError message={submitError} /> : null}
      {step === "destination" ? (
        <>
          <editorForm.Field
            name="name"
            validators={{ onChange: validateWithZod(webhookNameSchema) }}
          >
            {(field) => (
              <TextField
                label="Name"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="url"
            validators={{ onChange: validateWithZod(outboundUrlSchema) }}
          >
            {(field) => (
              <TextField
                label="Destination URL"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
                type="url"
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="enabled"
            validators={{ onChange: validateWithZod(webhookEnabledSchema) }}
          >
            {(field) => (
              <label className="webhooks-checkbox">
                <input
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                  type="checkbox"
                />
                Enabled
              </label>
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "payload" ? (
        <>
          <editorForm.Field
            name="eventSubjects"
            validators={{ onChange: validateWithZod(outboundEventSubjectsSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Event subjects"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={3}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="format"
            validators={{ onChange: validateWithZod(outboundFormatSchema) }}
          >
            {(field) => (
              <SelectField
                label="Format"
                value={field.state.value}
                values={outboundFormats}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="template"
            validators={{ onChange: validateWithZod(outboundTemplateSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Template"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="headersJson"
            validators={{ onChange: validateWithZod(outboundHeadersJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Headers JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "review" ? (
        <>
          <editorForm.Field
            name="metadataJson"
            validators={{ onChange: validateWithZod(metadataJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Metadata JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={5}
              />
            )}
          </editorForm.Field>
          <editorForm.Subscribe selector={(state) => state.values}>
            {(values) => <OutboundReview values={values} />}
          </editorForm.Subscribe>
        </>
      ) : null}
      <FormActions
        isSaving={isSaving}
        isLastStep={stepIndex === outboundEditorSteps.length - 1}
        onBack={
          stepIndex > 0 ? () => setStep(outboundEditorSteps[stepIndex - 1]?.id ?? step) : undefined
        }
        onCancel={onCancel}
        onNext={
          stepIndex < outboundEditorSteps.length - 1
            ? () => setStep(outboundEditorSteps[stepIndex + 1]?.id ?? step)
            : undefined
        }
      />
    </form>
  );
}

function InboundForm({
  form,
  isSaving,
  onCancel,
  onSubmit,
}: {
  readonly form: InboundFormState;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (form: InboundFormState) => void;
}) {
  const [step, setStep] = useState<InboundEditorStep>("receiver");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editorForm = useForm({
    defaultValues: form,
    onSubmit: ({ value }) => {
      const validationError = validateInboundForm(value);
      if (validationError !== null) {
        setSubmitError(validationError.message);
        setStep(validationError.step);
        return;
      }
      setSubmitError(null);
      onSubmit(value);
    },
  });
  const stepIndex = inboundEditorSteps.findIndex((item) => item.id === step);

  return (
    <form
      className="webhooks-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void editorForm.handleSubmit();
      }}
    >
      <EditorTitle mode={form.mode} title="inbound webhook" onCancel={onCancel} />
      <EditorSteps
        activeStep={step}
        ariaLabel="Inbound webhook setup steps"
        onStepChange={setStep}
        steps={inboundEditorSteps}
      />
      {submitError !== null ? <FormError message={submitError} /> : null}
      {step === "receiver" ? (
        <>
          <editorForm.Field
            name="name"
            validators={{ onChange: validateWithZod(webhookNameSchema) }}
          >
            {(field) => (
              <TextField
                label="Name"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="slug"
            validators={{ onChange: validateWithZod(inboundSlugSchema) }}
          >
            {(field) => (
              <TextField
                label="Slug"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                pattern="[a-z0-9][a-z0-9-]*"
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="source"
            validators={{ onChange: validateWithZod(inboundSourceSchema) }}
          >
            {(field) => (
              <SelectField
                label="Source"
                value={field.state.value}
                values={inboundSources}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="enabled"
            validators={{ onChange: validateWithZod(webhookEnabledSchema) }}
          >
            {(field) => (
              <label className="webhooks-checkbox">
                <input
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                  type="checkbox"
                />
                Enabled
              </label>
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "action" ? (
        <>
          <editorForm.Field
            name="actionToolId"
            validators={{ onChange: validateWithZod(inboundActionToolIdSchema) }}
          >
            {(field) => (
              <TextField
                label="Action tool ID"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="actionScopes"
            validators={{ onChange: validateWithZod(inboundActionScopesSchema) }}
          >
            {(field) => (
              <TextField
                label="Action scopes"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="actionInputJson"
            validators={{ onChange: validateWithZod(inboundActionInputJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Action input JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "review" ? (
        <>
          <editorForm.Field
            name="metadataJson"
            validators={{ onChange: validateWithZod(metadataJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Metadata JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={5}
              />
            )}
          </editorForm.Field>
          <editorForm.Subscribe selector={(state) => state.values}>
            {(values) => <InboundReview values={values} />}
          </editorForm.Subscribe>
        </>
      ) : null}
      <FormActions
        isSaving={isSaving}
        isLastStep={stepIndex === inboundEditorSteps.length - 1}
        onBack={
          stepIndex > 0 ? () => setStep(inboundEditorSteps[stepIndex - 1]?.id ?? step) : undefined
        }
        onCancel={onCancel}
        onNext={
          stepIndex < inboundEditorSteps.length - 1
            ? () => setStep(inboundEditorSteps[stepIndex + 1]?.id ?? step)
            : undefined
        }
      />
    </form>
  );
}

function DeliveriesPanel({
  deliveries,
  filters,
  isLoading,
  selectedDelivery,
  setFilters,
  setSelectedDelivery,
}: {
  readonly deliveries: readonly WebhookDelivery[];
  readonly filters: Required<DeliveryFilterState>;
  readonly isLoading: boolean;
  readonly selectedDelivery: WebhookDelivery | null;
  readonly setFilters: (filters: Required<DeliveryFilterState>) => void;
  readonly setSelectedDelivery: (delivery: WebhookDelivery | null) => void;
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
    [setSelectedDelivery],
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
          <table className="webhooks-table">
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
            mode="edit"
            title="delivery detail"
            onCancel={() => setSelectedDelivery(null)}
          />
          <DetailRow label="ID" value={selectedDelivery.id} />
          <DetailRow
            label="Webhook"
            value={selectedDelivery.outboundWebhookId ?? selectedDelivery.inboundWebhookId ?? "-"}
          />
          <DetailRow label="Direction" value={selectedDelivery.direction} />
          <DetailRow label="Status" value={selectedDelivery.status} />
          <DetailRow
            label="Response status"
            value={String(selectedDelivery.responseStatus ?? "-")}
          />
          <DetailRow label="Payload SHA-256" value={selectedDelivery.payloadSha256 ?? "-"} />
          <DetailRow label="Error" value={selectedDelivery.error ?? "-"} />
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

function PanelTitle({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="webhooks-panel-title">
      <h2>{title}</h2>
      <span>{detail}</span>
    </div>
  );
}

function EditorTitle({
  mode,
  title,
  onCancel,
}: {
  readonly mode: "create" | "edit";
  readonly title: string;
  readonly onCancel: () => void;
}) {
  return (
    <div className="webhooks-editor-title">
      <h2>
        {mode === "create" ? "New" : "Edit"} {title}
      </h2>
      <button className="icon-button" onClick={onCancel} title="Close editor" type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

function TextField({
  label,
  onChange,
  value,
  pattern,
  required,
  type = "text",
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
  readonly pattern?: string;
  readonly required?: boolean;
  readonly type?: string;
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <input
        pattern={pattern}
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextareaField({
  label,
  onChange,
  rows,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly rows: number;
  readonly value: string;
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  onChange,
  value,
  values,
}: {
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly value: string;
  readonly values: readonly T[];
}) {
  return (
    <label className="webhooks-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function FormActions({
  isSaving,
  isLastStep = true,
  onBack,
  onCancel,
  onNext,
}: {
  readonly isSaving: boolean;
  readonly isLastStep?: boolean;
  readonly onBack?: () => void;
  readonly onCancel: () => void;
  readonly onNext?: () => void;
}) {
  return (
    <div className="webhooks-form-actions">
      <button className="helix-button helix-button-secondary" onClick={onCancel} type="button">
        Cancel
      </button>
      {onBack !== undefined ? (
        <button className="helix-button helix-button-secondary" onClick={onBack} type="button">
          Back
        </button>
      ) : null}
      {isLastStep ? (
        <button className="helix-button" disabled={isSaving} type="submit">
          <Save aria-hidden="true" size={16} />
          Save
        </button>
      ) : (
        <button className="helix-button" onClick={onNext} type="button">
          Continue
        </button>
      )}
    </div>
  );
}

function EditorSteps<Step extends string>({
  activeStep,
  ariaLabel,
  onStepChange,
  steps,
}: {
  readonly activeStep: Step;
  readonly ariaLabel: string;
  readonly onStepChange: (step: Step) => void;
  readonly steps: readonly { readonly id: Step; readonly label: string }[];
}) {
  return (
    <div className="webhooks-tabs" role="tablist" aria-label={ariaLabel}>
      {steps.map((step) => (
        <button
          aria-selected={activeStep === step.id}
          className={activeStep === step.id ? "webhooks-tab active" : "webhooks-tab"}
          key={step.id}
          onClick={() => onStepChange(step.id)}
          role="tab"
          type="button"
        >
          {step.label}
        </button>
      ))}
    </div>
  );
}

function FormError({ message }: { readonly message: string }) {
  return (
    <div className="webhooks-error-panel" role="alert">
      <strong>Review this step</strong>
      <span>{message}</span>
    </div>
  );
}

function OutboundReview({ values }: { readonly values: OutboundFormState }) {
  const subjects = splitList(values.eventSubjects);
  return (
    <>
      <DetailRow label="Destination" value={values.url.trim() === "" ? "-" : values.url.trim()} />
      <DetailRow
        label="Events"
        value={subjects.length === 0 ? "All events" : subjects.join(", ")}
      />
      <DetailRow label="Format" value={values.format} />
      <DetailRow label="Status" value={values.enabled ? "Enabled" : "Disabled"} />
    </>
  );
}

function InboundReview({ values }: { readonly values: InboundFormState }) {
  const toolId = values.actionToolId.trim();
  return (
    <>
      <DetailRow
        label="Endpoint"
        value={values.slug.trim() === "" ? "-" : `/webhooks/${values.slug.trim()}`}
      />
      <DetailRow label="Source" value={values.source} />
      <DetailRow label="Action" value={toolId === "" ? "Record only" : toolId} />
      <DetailRow label="Status" value={values.enabled ? "Enabled" : "Disabled"} />
    </>
  );
}

function RowActions({ children }: { readonly children: ReactNode }) {
  return <div className="webhooks-row-actions">{children}</div>;
}

function EmptyRow({ colSpan, text }: { readonly colSpan: number; readonly text: string }) {
  return (
    <tr>
      <td className="webhooks-empty-cell" colSpan={colSpan}>
        {text}
      </td>
    </tr>
  );
}

function StatusPill({ enabled }: { readonly enabled: boolean }) {
  return (
    <span className={enabled ? "webhooks-pill enabled" : "webhooks-pill disabled"}>
      {enabled ? "enabled" : "disabled"}
    </span>
  );
}

function DeliveryStatusPill({ status }: { readonly status: WebhookDeliveryStatus }) {
  return <span className={`webhooks-pill ${status}`}>{status}</span>;
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="webhooks-detail-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function outboundInputFromForm(form: OutboundFormState) {
  const metadata = parseJsonRecord(form.metadataJson);
  return {
    name: form.name.trim(),
    url: form.url.trim(),
    eventSubjects: splitList(form.eventSubjects),
    headers: parseJsonRecord(form.headersJson) as Record<string, string>,
    enabled: form.enabled,
    metadata: compactRecord({
      ...metadata,
      format: form.format,
      template: form.template.trim() === "" ? undefined : form.template,
    }),
  };
}

function inboundInputFromForm(form: InboundFormState) {
  const metadata = parseJsonRecord(form.metadataJson);
  const actionToolId = form.actionToolId.trim();
  return {
    name: form.name.trim(),
    slug: form.slug.trim(),
    source: form.source,
    enabled: form.enabled,
    metadata: compactRecord({
      ...metadata,
      action:
        actionToolId === ""
          ? undefined
          : compactRecord({
              toolId: actionToolId,
              scopes: splitList(form.actionScopes),
              input:
                form.actionInputJson.trim() === "" ? undefined : JSON.parse(form.actionInputJson),
            }),
    }),
  };
}

function validateOutboundForm(
  form: OutboundFormState,
): { readonly step: OutboundEditorStep; readonly message: string } | null {
  const nameError = schemaError(webhookNameSchema, form.name);
  if (nameError !== null) return { step: "destination", message: nameError };
  const urlError = schemaError(outboundUrlSchema, form.url);
  if (urlError !== null) return { step: "destination", message: urlError };
  const headersError = schemaError(outboundHeadersJsonSchema, form.headersJson);
  if (headersError !== null) return { step: "payload", message: headersError };
  const metadataError = schemaError(metadataJsonSchema, form.metadataJson);
  if (metadataError !== null) return { step: "review", message: metadataError };
  return null;
}

function validateInboundForm(
  form: InboundFormState,
): { readonly step: InboundEditorStep; readonly message: string } | null {
  const nameError = schemaError(webhookNameSchema, form.name);
  if (nameError !== null) return { step: "receiver", message: nameError };
  const slugError = schemaError(inboundSlugSchema, form.slug);
  if (slugError !== null) return { step: "receiver", message: slugError };
  const sourceError = schemaError(inboundSourceSchema, form.source);
  if (sourceError !== null) return { step: "receiver", message: sourceError };
  const actionInputError = schemaError(inboundActionInputJsonSchema, form.actionInputJson);
  if (actionInputError !== null) return { step: "action", message: actionInputError };
  const metadataError = schemaError(metadataJsonSchema, form.metadataJson);
  if (metadataError !== null) return { step: "review", message: metadataError };
  return null;
}

function jsonRecordFieldSchema(label: string) {
  return z.string().superRefine((value, context) => {
    try {
      parseJsonRecord(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} is invalid: ${errorMessage(error)}`,
      });
    }
  });
}

function validateWithZod(schema: z.ZodTypeAny) {
  return ({ value }: { readonly value: unknown }) => schemaError(schema, value) ?? undefined;
}

function schemaError(schema: z.ZodTypeAny, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? "Invalid value.");
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function outboundFormFromWebhook(webhook: OutboundWebhook): OutboundFormState {
  return {
    mode: "edit",
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    eventSubjects: webhook.eventSubjects.join("\n"),
    enabled: webhook.enabled,
    format: stringMetadata(webhook.metadata, "format") ?? "generic",
    template: stringMetadata(webhook.metadata, "template") ?? "",
    headersJson: JSON.stringify(webhook.headers, null, 2),
    metadataJson: JSON.stringify(webhook.metadata, null, 2),
  };
}

function inboundFormFromWebhook(webhook: InboundWebhook): InboundFormState {
  const action = isRecord(webhook.metadata.action) ? webhook.metadata.action : {};
  return {
    mode: "edit",
    id: webhook.id,
    name: webhook.name,
    slug: webhook.slug,
    source: webhook.source,
    enabled: webhook.enabled,
    actionToolId: typeof action.toolId === "string" ? action.toolId : "",
    actionScopes: Array.isArray(action.scopes)
      ? action.scopes.filter((scope): scope is string => typeof scope === "string").join(", ")
      : "",
    actionInputJson: action.input === undefined ? "" : JSON.stringify(action.input, null, 2),
    metadataJson: JSON.stringify(webhook.metadata, null, 2),
  };
}

function formKey(form: Pick<OutboundFormState | InboundFormState, "id" | "mode">): string {
  return `${form.mode}:${form.id ?? "new"}`;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON value must be an object.");
  }
  return parsed;
}

function splitList(value: string): readonly string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function actionLabel(metadata: Record<string, unknown>): string {
  const action = metadata.action;
  if (!isRecord(action) || typeof action.toolId !== "string") {
    return "Record only";
  }
  return action.toolId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebhookDirection(value: string): value is WebhookDirection {
  return value === "outbound" || value === "inbound";
}

function isWebhookDeliveryStatus(value: string): value is WebhookDeliveryStatus {
  return webhookDeliveryStatuses.includes(value as WebhookDeliveryStatus);
}

function isRotateOutput(value: unknown): value is { readonly secretRef: string } {
  return isRecord(value) && typeof value.secretRef === "string";
}

interface WebhookMutationContext {
  readonly outbound?: readonly OutboundWebhook[];
  readonly inbound?: readonly InboundWebhook[];
}

async function cancelWebhookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: webhookQueryKeys.outbound }),
    queryClient.cancelQueries({ queryKey: webhookQueryKeys.inbound }),
    queryClient.cancelQueries({ queryKey: ["webhooks", "deliveries"] }),
  ]);
}

function snapshotWebhookQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): WebhookMutationContext {
  return {
    outbound: queryClient.getQueryData<readonly OutboundWebhook[]>(webhookQueryKeys.outbound),
    inbound: queryClient.getQueryData<readonly InboundWebhook[]>(webhookQueryKeys.inbound),
  };
}

function rollbackWebhookQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  context: WebhookMutationContext | undefined,
) {
  if (context?.outbound !== undefined) {
    queryClient.setQueryData(webhookQueryKeys.outbound, context.outbound);
  }
  if (context?.inbound !== undefined) {
    queryClient.setQueryData(webhookQueryKeys.inbound, context.inbound);
  }
}

function optimisticOutboundSave(
  current: readonly OutboundWebhook[] | undefined,
  form: OutboundFormState,
): readonly OutboundWebhook[] {
  const input = outboundInputFromForm(form);
  const webhooks = current ?? [];
  if (form.mode === "edit" && form.id !== undefined) {
    return webhooks.map((webhook) =>
      webhook.id === form.id
        ? {
            ...webhook,
            ...input,
            updatedAt: new Date().toISOString(),
          }
        : webhook,
    );
  }
  return [
    {
      id: optimisticId("outbound"),
      orgId: "",
      secretRef: "inline:pending",
      createdByActorId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    },
    ...webhooks,
  ];
}

function optimisticInboundSave(
  current: readonly InboundWebhook[] | undefined,
  form: InboundFormState,
): readonly InboundWebhook[] {
  const input = inboundInputFromForm(form);
  const webhooks = current ?? [];
  if (form.mode === "edit" && form.id !== undefined) {
    return webhooks.map((webhook) =>
      webhook.id === form.id
        ? {
            ...webhook,
            ...input,
            updatedAt: new Date().toISOString(),
          }
        : webhook,
    );
  }
  return [
    {
      id: optimisticId("inbound"),
      orgId: "",
      secretRef: "inline:pending",
      createdByActorId: null,
      lastReceivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    },
    ...webhooks,
  ];
}

function optimisticOutboundAction(
  current: readonly OutboundWebhook[] | undefined,
  action: OutboundRowAction,
): readonly OutboundWebhook[] {
  const webhooks = current ?? [];
  if (action.type === "delete") {
    return webhooks.filter((webhook) => webhook.id !== action.webhook.id);
  }
  if (action.type === "toggle") {
    return webhooks.map((webhook) =>
      webhook.id === action.webhook.id
        ? { ...webhook, enabled: !webhook.enabled, updatedAt: new Date().toISOString() }
        : webhook,
    );
  }
  if (action.type === "rotate") {
    return webhooks.map((webhook) =>
      webhook.id === action.webhook.id
        ? { ...webhook, secretRef: "inline:pending", updatedAt: new Date().toISOString() }
        : webhook,
    );
  }
  return webhooks;
}

function optimisticInboundAction(
  current: readonly InboundWebhook[] | undefined,
  action: InboundRowAction,
): readonly InboundWebhook[] {
  const webhooks = current ?? [];
  if (action.type === "delete") {
    return webhooks.filter((webhook) => webhook.id !== action.webhook.id);
  }
  if (action.type === "toggle") {
    return webhooks.map((webhook) =>
      webhook.id === action.webhook.id
        ? { ...webhook, enabled: !webhook.enabled, updatedAt: new Date().toISOString() }
        : webhook,
    );
  }
  if (action.type === "rotate") {
    return webhooks.map((webhook) =>
      webhook.id === action.webhook.id
        ? { ...webhook, secretRef: "inline:pending", updatedAt: new Date().toISOString() }
        : webhook,
    );
  }
  return webhooks;
}

function optimisticId(prefix: string): string {
  return `optimistic-${prefix}-${String(Date.now())}`;
}

async function invalidateWebhookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: webhookQueryKeys.outbound }),
    queryClient.invalidateQueries({ queryKey: webhookQueryKeys.inbound }),
    queryClient.invalidateQueries({ queryKey: ["webhooks", "deliveries"] }),
  ]);
}

function showError(error: Error) {
  toast.error(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outboundActionLabel(type: OutboundRowAction["type"]): string {
  if (type === "delete") {
    return "Outbound webhook deleted";
  }
  if (type === "test") {
    return "Outbound test fired";
  }
  if (type === "rotate") {
    return "Outbound signing secret rotated";
  }
  return "Outbound webhook updated";
}

function inboundActionLabel(type: InboundRowAction["type"]): string {
  if (type === "delete") {
    return "Inbound webhook deleted";
  }
  if (type === "test") {
    return "Inbound test verified";
  }
  if (type === "rotate") {
    return "Inbound secret rotated";
  }
  return "Inbound webhook updated";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDate(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function dateTimeFilterToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast.success("Copied");
}
