import { useAdminSectionTab } from "@/features/admin/admin-section-search";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Activity, Copy, Plus, RefreshCw, Webhook, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { WebhookDeliveryListInput } from "./api";
import {
  DEFAULT_DELIVERY_LIMIT,
  createInboundWebhook,
  createOutboundWebhook,
  deleteInboundWebhook,
  deleteOutboundWebhook,
  generateInlineSecretRef,
  replayWebhookDelivery,
  rotateInboundSecret,
  testInboundWebhook,
  testOutboundWebhook,
  updateInboundWebhook,
  updateOutboundWebhook,
  webhookDeliveriesQueryOptions,
  webhookOverviewQueryOptions,
} from "./api";
import type { WebhookDelivery } from "./types";
import {
  cancelWebhookQueries,
  invalidateWebhookQueries,
  optimisticInboundSave,
  optimisticOutboundSave,
  optimisticRowAction,
  patchOverview,
  rollbackWebhookQueries,
  snapshotWebhookQueries,
} from "./webhook-cache";
import { QueryErrors, SummaryMetric } from "./webhook-controls";
import {
  DeliveriesPanel,
  type DeliveryFilterState,
  dateTimeFilterToIso,
  isFilteredDeliveryInput,
  isWebhookDeliveryStatus,
  isWebhookDirection,
} from "./webhook-deliveries";
import {
  type InboundFormState,
  type OutboundFormState,
  emptyInboundForm,
  emptyOutboundForm,
  formKey,
  inboundFormFromWebhook,
  inboundInputFromForm,
  outboundFormFromWebhook,
  outboundInputFromForm,
} from "./webhook-form-state";
import { copyText, isRotateOutput, showError } from "./webhook-format";
import { InboundForm, OutboundForm } from "./webhook-forms";
import {
  type InboundRowAction,
  InboundTable,
  type OutboundRowAction,
  OutboundTable,
  webhookActionLabels,
} from "./webhook-tables";

export const WEBHOOK_TABS = ["outbound", "inbound", "deliveries"] as const;

export type WebhookTab = (typeof WEBHOOK_TABS)[number];

export const DEFAULT_WEBHOOK_TAB: WebhookTab = "outbound";

/* Three sibling views of one section, one visible at a time: a real tabset, so
   it gets the full ARIA tabs contract (panel ids, roving tabindex, arrow keys)
   rather than the half-declared `role="tab"` it used to carry. */
const WEBHOOK_TAB_VIEWS: readonly {
  readonly id: WebhookTab;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "outbound", label: "Outbound", icon: Webhook },
  { id: "inbound", label: "Inbound", icon: Webhook },
  { id: "deliveries", label: "Deliveries", icon: Activity },
];

const webhookTabDomId = (tab: WebhookTab) => `webhooks-tab-${tab}`;

const webhookPanelDomId = (tab: WebhookTab) => `webhooks-panel-${tab}`;

export function WebhookManagement() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useAdminSectionTab(
    WEBHOOK_TABS,
    DEFAULT_WEBHOOK_TAB,
    "webhooks",
  );
  const tabRefs = useRef<Partial<Record<WebhookTab, HTMLButtonElement | null>>>({});
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

  const deliveryLimit = deliveryInput.limit ?? DEFAULT_DELIVERY_LIMIT;

  /* The whole section in one request. Three separate tool calls put this page
     over the tenant's five-per-second budget on every cold load — the shell
     already spends two — so it rendered "Tenant API request rate limit
     exceeded" instead of its content, and `retry: false` made that stick. */
  const overviewQuery = useQuery(webhookOverviewQueryOptions(deliveryLimit));
  const overview = overviewQuery.data;

  /* A second request only once the operator narrows the log. Unfiltered, the
     overview's own delivery page is exactly what this tab would have asked
     for. */
  const deliveriesFiltered = isFilteredDeliveryInput(deliveryInput);
  const deliveriesQuery = useQuery({
    ...webhookDeliveriesQueryOptions(deliveryInput),
    enabled: deliveriesFiltered,
  });

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
      patchOverview(queryClient, deliveryLimit, (current) => ({
        ...current,
        outbound: optimisticOutboundSave(current.outbound, form),
      }));
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
      patchOverview(queryClient, deliveryLimit, (current) => ({
        ...current,
        inbound: optimisticInboundSave(current.inbound, form),
      }));
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
      patchOverview(queryClient, deliveryLimit, (current) => ({
        ...current,
        outbound: optimisticRowAction(current.outbound, action),
      }));
      return context;
    },
    onSuccess: async (_output, action) => {
      setPendingDelete(null);
      await invalidateWebhookQueries(queryClient);
      toast.success(webhookActionLabels.outbound[action.type]);
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
      patchOverview(queryClient, deliveryLimit, (current) => ({
        ...current,
        inbound: optimisticRowAction(current.inbound, action),
      }));
      return context;
    },
    onSuccess: async (output, action) => {
      setPendingDelete(null);
      if (action.type === "rotate" && isRotateOutput(output)) {
        setRotatedSecret(output.secretRef);
      }
      await invalidateWebhookQueries(queryClient);
      toast.success(webhookActionLabels.inbound[action.type]);
    },
    onError: (error, _action, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  /* `webhook.outbound.replay` has existed on the backend since the feature
     landed with nothing in the UI able to reach it, so a failed delivery was a
     dead end — the operator could read the error and had no way to act on it. */
  const replayMutation = useMutation({
    mutationFn: (deliveryId: string) => replayWebhookDelivery(deliveryId),
    onMutate: async () => {
      await cancelWebhookQueries(queryClient);
      return snapshotWebhookQueries(queryClient);
    },
    onSuccess: async (result) => {
      /* Re-select the replayed row so the detail pane shows the new attempt's
         response rather than the failure the operator was looking at. */
      if (result.delivery !== null) {
        setSelectedDelivery(result.delivery);
      }
      await invalidateWebhookQueries(queryClient);
      toast.success(
        result.delivery?.status === "delivered" ? "Delivery replayed" : "Replay attempted",
      );
    },
    onError: (error: Error, _deliveryId, context) => {
      rollbackWebhookQueries(queryClient, context);
      showError(error);
    },
  });

  const outboundWebhooks = overview?.outbound ?? [];
  const inboundWebhooks = overview?.inbound ?? [];
  const deliveries = (deliveriesFiltered ? deliveriesQuery.data : overview?.deliveries) ?? [];
  /* Distinguishing "the list is empty" from "we could not read it" is the whole
     point of these two, so they track the query that actually produced the
     rows rather than assuming the overview did. */
  const deliveriesLoaded = deliveriesFiltered
    ? deliveriesQuery.data !== undefined
    : overview !== undefined;
  const deliveriesLoading = deliveriesFiltered
    ? deliveriesQuery.isLoading
    : overviewQuery.isLoading;

  /* Delivery rows name their endpoint by raw UUID. An operator triaging a
     failure should not have to match a UUID against a table by eye. */
  const webhookNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const webhook of outboundWebhooks) names.set(webhook.id, webhook.name);
    for (const webhook of inboundWebhooks) names.set(webhook.id, webhook.name);
    return names;
  }, [outboundWebhooks, inboundWebhooks]);

  /* The bar announced itself as a tablist but had no arrow keys and no roving
     tabindex, so a screen reader heard "tab, 1 of 3" and then got none of the
     behaviour that promises. Left/Right wrap, Home/End jump to the ends —
     the same interface as the mail admin tab bar. */
  const moveTabSelection = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = WEBHOOK_TAB_VIEWS.length - 1;
    const current = WEBHOOK_TAB_VIEWS.findIndex((view) => view.id === activeTab);
    const nextIndex =
      event.key === "ArrowRight"
        ? (current + 1) % WEBHOOK_TAB_VIEWS.length
        : event.key === "ArrowLeft"
          ? (current + last) % WEBHOOK_TAB_VIEWS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (nextIndex === null) {
      return;
    }
    const next = WEBHOOK_TAB_VIEWS[nextIndex];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setActiveTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

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
        <SummaryMetric
          label="Outbound"
          value={overview === undefined ? null : outboundWebhooks.length}
        />
        <SummaryMetric
          label="Inbound"
          value={overview === undefined ? null : inboundWebhooks.length}
        />
        <SummaryMetric
          label="Enabled"
          /* Needs both lists: half a total is a wrong number, not a partial one. */
          value={
            overview === undefined
              ? null
              : outboundWebhooks.filter((item) => item.enabled).length +
                inboundWebhooks.filter((item) => item.enabled).length
          }
        />
        <SummaryMetric
          label="Failed deliveries"
          value={
            !deliveriesLoaded ? null : deliveries.filter((item) => item.status === "failed").length
          }
          tone="danger"
        />
      </div>

      <div
        className="webhooks-tabs"
        role="tablist"
        aria-label="Webhook sections"
        onKeyDown={moveTabSelection}
      >
        {WEBHOOK_TAB_VIEWS.map((view) => {
          const active = view.id === activeTab;
          return (
            <button
              key={view.id}
              id={webhookTabDomId(view.id)}
              ref={(node) => {
                tabRefs.current[view.id] = node;
              }}
              aria-controls={webhookPanelDomId(view.id)}
              aria-selected={active}
              className={active ? "webhooks-tab active" : "webhooks-tab"}
              onClick={() => setActiveTab(view.id)}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              <view.icon aria-hidden="true" size={16} />
              {view.label}
            </button>
          );
        })}
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

      <QueryErrors errors={[overviewQuery.error, deliveriesQuery.error]} />

      {activeTab === "outbound" ? (
        <div
          className="webhooks-grid"
          id={webhookPanelDomId("outbound")}
          role="tabpanel"
          aria-labelledby={webhookTabDomId("outbound")}
        >
          <OutboundTable
            failed={overview === undefined && !overviewQuery.isLoading}
            isBusy={overviewQuery.isLoading || outboundActionMutation.isPending}
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
        <div
          className="webhooks-grid"
          id={webhookPanelDomId("inbound")}
          role="tabpanel"
          aria-labelledby={webhookTabDomId("inbound")}
        >
          <InboundTable
            failed={overview === undefined && !overviewQuery.isLoading}
            isBusy={overviewQuery.isLoading || inboundActionMutation.isPending}
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
        <div
          id={webhookPanelDomId("deliveries")}
          role="tabpanel"
          aria-labelledby={webhookTabDomId("deliveries")}
        >
          <DeliveriesPanel
            deliveries={deliveries}
            filters={deliveryFilters}
            isLoading={deliveriesLoading}
            selectedDelivery={selectedDelivery}
            setFilters={setDeliveryFilters}
            setSelectedDelivery={setSelectedDelivery}
            webhookNames={webhookNames}
            onReplay={(deliveryId) => {
              replayMutation.mutate(deliveryId);
            }}
            isReplaying={replayMutation.isPending}
          />
        </div>
      ) : null}
    </section>
  );
}
