import type postgres from "postgres";
import { evaluateAgentDefender, type AgentDefenderAuth } from "./defender-policy.js";
import { PostgresAgentDefenderStore } from "./defender-store.js";
import type { MailStore } from "./store.js";
import type { MailInboundRecipient } from "./types.js";

export interface AgentDefenderIngest {
  readonly store: PostgresAgentDefenderStore;
  readonly lookupActorTypes: (
    orgId: string,
    actorIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
}

export function createAgentDefenderIngest(sql: postgres.Sql): AgentDefenderIngest {
  const store = new PostgresAgentDefenderStore(sql);
  return {
    store,
    lookupActorTypes: async (orgId, actorIds) => {
      if (actorIds.length === 0) return new Map();
      const rows = await sql<{ readonly id: string; readonly type: string }[]>`
        select id, type from actors
        where org_id = ${orgId} and id in ${sql(actorIds)}
      `;
      return new Map(rows.map((row) => [row.id, row.type]));
    },
  };
}

export async function finishInboundAgentDefender(
  ingest: {
    readonly agentDefender?: AgentDefenderIngest;
    readonly store: Pick<MailStore, "updateThreadState">;
    readonly input: { readonly orgId: string; readonly receivedAt?: Date };
  },
  deliveredRecipients: readonly MailInboundRecipient[],
  fromAddress: string,
  parsed: { readonly subject?: unknown; readonly text?: unknown },
  auth: AgentDefenderAuth,
  alreadySpam: boolean,
  stored: { readonly threadId: string; readonly messageId: string },
): Promise<void> {
  await maybeApplyAgentDefenderAfterIngest(ingest.agentDefender, {
    mail: ingest.store,
    orgId: ingest.input.orgId,
    recipients: deliveredRecipients,
    fromAddress,
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    bodyText: typeof parsed.text === "string" ? parsed.text : "",
    auth,
    alreadySpam,
    threadId: stored.threadId,
    messageId: stored.messageId,
    now: ingest.input.receivedAt ?? new Date(),
  });
}

async function maybeApplyAgentDefenderAfterIngest(
  defender: AgentDefenderIngest | undefined,
  input: Omit<Parameters<typeof applyAgentDefenderAfterIngest>[0], "defender">,
): Promise<void> {
  if (defender === undefined) return;
  await applyAgentDefenderAfterIngest({ ...input, defender });
}

export async function applyAgentDefenderAfterIngest(input: {
  readonly mail: Pick<MailStore, "updateThreadState">;
  readonly defender: AgentDefenderIngest;
  readonly orgId: string;
  readonly recipients: readonly MailInboundRecipient[];
  readonly fromAddress: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly auth: AgentDefenderAuth;
  readonly alreadySpam: boolean;
  readonly threadId: string;
  readonly messageId: string;
  readonly now: Date;
}): Promise<void> {
  if (input.recipients.length === 0) return;
  const types = await input.defender.lookupActorTypes(
    input.orgId,
    input.recipients.map((recipient) => recipient.actorId),
  );
  await Promise.all(
    input.recipients.map(async (recipient) => {
      const actorType = types.get(recipient.actorId) ?? "user";
      if (actorType !== "agent") return;
      const policy = await input.defender.store.getPolicy(input.orgId, recipient.actorId);
      const decision = evaluateAgentDefender({
        actorType,
        policy,
        fromAddress: input.fromAddress,
        subject: input.subject,
        bodyText: input.bodyText,
        auth: input.auth,
        alreadySpam: input.alreadySpam,
      });
      if (decision.verdict === "hold") {
        await input.mail.updateThreadState({
          orgId: input.orgId,
          actorId: recipient.actorId,
          threadId: input.threadId,
          patch: { heldAt: input.now },
        });
        return;
      }
      if (decision.verdict === "junk" && !input.alreadySpam) {
        await input.mail.updateThreadState({
          orgId: input.orgId,
          actorId: recipient.actorId,
          threadId: input.threadId,
          patch: { spamAt: input.now },
        });
        return;
      }
      if (decision.verdict === "deliver" && policy?.loopEnabled === true) {
        await input.defender.store.enqueueLoopJob({
          orgId: input.orgId,
          agentActorId: recipient.actorId,
          messageId: input.messageId,
          threadId: input.threadId,
        });
      }
    }),
  );
}
