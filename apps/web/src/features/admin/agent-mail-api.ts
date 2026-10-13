import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";
import { ensureOk, parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — agent mail.
 *
 * `/api/admin/agent-mail` gives an agent a mail address and says who may write
 * to it from outside. Mail that an agent's policy does not admit waits in the
 * mail quarantine (`/api/admin/mail/quarantine`) until an administrator
 * delivers or deletes it.
 */

const receiveModeSchema = z.enum(["allowed_senders", "anyone"]);

const agentMailboxSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  type: z.enum(["agent", "service_account"]),
  disabled: z.boolean(),
  address: z.string().nullable(),
  receiveMode: receiveModeSchema,
  allowedSenders: z.array(z.string()),
});

const heldMailSchema = z.object({
  id: z.string(),
  recipientAddresses: z.array(z.string()),
  envelopeFrom: z.string().nullable(),
  fromAddress: z.string().nullable().default(null),
  signature: z.string(),
  createdAt: z.string(),
});

export type AgentMailbox = z.infer<typeof agentMailboxSchema>;
export type AgentMailReceiveMode = z.infer<typeof receiveModeSchema>;
export type HeldAgentMail = z.infer<typeof heldMailSchema>;

const AGENT_MAIL_PATH = "/api/admin/agent-mail";
const QUARANTINE_PATH = "/api/admin/mail/quarantine";
/** How the quarantine marks mail held by an agent's policy. */
const HOLD_SIGNATURE_PREFIX = "agent-mail:";
const json = { "content-type": "application/json" } as const;

export const agentMailQueryKey = ["admin", "agent-mail"] as const;
export const heldAgentMailQueryKey = ["admin", "agent-mail", "held"] as const;

export function agentMailQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: agentMailQueryKey,
    queryFn: async () =>
      parseResponse(
        await fetchImpl(AGENT_MAIL_PATH),
        "load agent mail",
        z.object({ agents: z.array(agentMailboxSchema), domains: z.array(z.string()) }),
      ),
  });
}

export async function saveAgentMail(
  id: string,
  input: {
    readonly address: string | null;
    readonly receiveMode: AgentMailReceiveMode;
    readonly allowedSenders: readonly string[];
  },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentMailbox> {
  const response = await fetchImpl(`${AGENT_MAIL_PATH}/${id}`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify(input),
  });
  return (
    await parseResponse(
      response,
      "save the agent's mail settings",
      z.object({ agent: agentMailboxSchema }),
    )
  ).agent;
}

/** Mail held by an agent's policy, newest first. Other quarantined mail is left out. */
export function heldAgentMailQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: heldAgentMailQueryKey,
    queryFn: async () =>
      (
        await parseResponse(
          await fetchImpl(QUARANTINE_PATH),
          "load held mail",
          z.object({ quarantines: z.array(heldMailSchema) }),
        )
      ).quarantines.filter((held) => held.signature.startsWith(HOLD_SIGNATURE_PREFIX)),
  });
}

/** Why a message was held, read from its quarantine signature. */
export function holdReasons(held: HeldAgentMail): readonly string[] {
  return held.signature.slice(HOLD_SIGNATURE_PREFIX.length).split(",");
}

export async function deliverHeldMail(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await ensureOk(
    await fetchImpl(`${QUARANTINE_PATH}/${id}/release`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        reason: "Delivered to the agent from Admin → Agent mail.",
        confirmed: true,
      }),
    }),
    "deliver the message",
  );
}

export async function deleteHeldMail(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await ensureOk(
    await fetchImpl(`${QUARANTINE_PATH}/${id}`, {
      method: "DELETE",
      headers: json,
      body: JSON.stringify({ reason: "Deleted from Admin → Agent mail.", confirmed: true }),
    }),
    "delete the message",
  );
}
