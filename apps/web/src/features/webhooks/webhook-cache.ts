import { useQueryClient } from "@tanstack/react-query";
import { webhookQueryKeys, type WebhookOverview } from "./api";
import type { InboundWebhook, OutboundWebhook } from "./types";
import {
  inboundInputFromForm,
  outboundInputFromForm,
  type InboundFormState,
  type OutboundFormState,
} from "./webhook-form-state";
import { type WebhookRowAction } from "./webhook-tables";

interface WebhookMutationContext {
  /** Every cached overview entry and its key, for an exact rollback. */
  readonly overviews: readonly (readonly [readonly unknown[], WebhookOverview | undefined])[];
}

export async function cancelWebhookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  /* One prefix: every webhook query lives under ["webhooks", …], including the
     overview the section now reads. Listing the leaves individually is how the
     overview would get missed when someone adds the next one. */
  await queryClient.cancelQueries({ queryKey: ["webhooks"] });
}

/** Apply an optimistic edit to the single cache entry the section renders. */
export function patchOverview(
  queryClient: ReturnType<typeof useQueryClient>,
  deliveryLimit: number,
  patch: (current: WebhookOverview) => WebhookOverview,
): void {
  queryClient.setQueryData<WebhookOverview>(webhookQueryKeys.overview(deliveryLimit), (current) =>
    patch(current ?? { outbound: [], inbound: [], deliveries: [] }),
  );
}

export function snapshotWebhookQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): WebhookMutationContext {
  /* Snapshot every overview entry, not one limit's worth: the delivery limit is
     part of the key, so an operator who changed it would otherwise get an
     optimistic edit that no rollback could undo. */
  return {
    overviews: queryClient.getQueriesData<WebhookOverview>({ queryKey: ["webhooks", "overview"] }),
  };
}

export function rollbackWebhookQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  context: WebhookMutationContext | undefined,
) {
  for (const [key, data] of context?.overviews ?? []) {
    if (data !== undefined) {
      queryClient.setQueryData(key, data);
    }
  }
}

/** Where an optimistic save lands: an edit rewrites the row in place, a create
 *  goes to the front of the list. The row itself is direction-specific, so the
 *  two builders come from the caller. */
function optimisticSave<Webhook extends { readonly id: string }>(
  current: readonly Webhook[] | undefined,
  form: Pick<OutboundFormState | InboundFormState, "id" | "mode">,
  buildCreated: () => Webhook,
  buildUpdated: (webhook: Webhook) => Webhook,
): readonly Webhook[] {
  const webhooks = current ?? [];
  if (form.mode === "edit" && form.id !== undefined) {
    return webhooks.map((webhook) => (webhook.id === form.id ? buildUpdated(webhook) : webhook));
  }
  return [buildCreated(), ...webhooks];
}

export function optimisticOutboundSave(
  current: readonly OutboundWebhook[] | undefined,
  form: OutboundFormState,
): readonly OutboundWebhook[] {
  const input = outboundInputFromForm(form);
  return optimisticSave(
    current,
    form,
    () => ({
      id: optimisticId("outbound"),
      orgId: "",
      secretRef: "inline:pending",
      createdByActorId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    }),
    (webhook) => ({
      ...webhook,
      ...input,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export function optimisticInboundSave(
  current: readonly InboundWebhook[] | undefined,
  form: InboundFormState,
): readonly InboundWebhook[] {
  const input = inboundInputFromForm(form);
  return optimisticSave(
    current,
    form,
    () => ({
      id: optimisticId("inbound"),
      orgId: "",
      secretRef: "inline:pending",
      createdByActorId: null,
      lastReceivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    }),
    (webhook) => ({
      ...webhook,
      ...input,
      updatedAt: new Date().toISOString(),
    }),
  );
}

/** The fields an optimistic row edit touches. Both webhook shapes carry them,
 *  and nothing here reads anything direction-specific — which is why one
 *  function serves both lists. */
interface OptimisticWebhookRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly secretRef: string | null;
  readonly updatedAt: string;
}

/* `test` falls through to the untouched list on purpose: firing a test changes
   nothing about the endpoint, so there is no local edit to show. */
export function optimisticRowAction<Webhook extends OptimisticWebhookRow>(
  current: readonly Webhook[] | undefined,
  action: WebhookRowAction<Webhook>,
): readonly Webhook[] {
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

export async function invalidateWebhookQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ["webhooks"] });
}
