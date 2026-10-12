import { MAIL_LABEL_COLOR_NAMES, type MailLabelColorName } from "@helix/contracts";
import type postgres from "postgres";
import { LocalMailTransport } from "../../platform/mail/local-delivery.js";
import { tenantMailClaims } from "../../platform/mail/outbound-claims.js";
import {
  MailSendService,
  OutboundMailDispatcher,
  OutboundMailWorker,
} from "../../platform/mail/outbound.js";
import { withTenantPostgresContext } from "../../platform/tenancy/postgres-roles.js";
import { activePeople, COMPANY, type Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import type { DemoDns } from "./dns.js";
import type { Directory } from "./directory.js";
import {
  address,
  announcement,
  internalConversation,
  signature,
  type InternalMessagePlan,
} from "./mail-content.js";
import {
  companyMailbox,
  customerPlans,
  InboundMailDesk,
  inboundPlans,
  type InboundKind,
} from "./mail-inbound.js";
import { demoRelay, type MimeAddress } from "./mail-mime.js";
import { recordDeliveredMail } from "./mail-history.js";
import { SeedRandom, seedUuid, TIME } from "./random.js";

/** Mail newer than this is sent through the live queue rather than recorded with its date. */
const RECENT_MAIL_MS = 6 * TIME.HOUR;
import { DemoSeedError, type DemoRuntime } from "./runtime.js";
import { externalAddress, FEATURES, NEWSLETTERS } from "./world.js";

export interface MailSeed {
  readonly internalThreads: number;
  readonly internalMessages: number;
  /** Of those, sent through the live queue today. */
  readonly queuedMessages: number;
  readonly inboundMessages: number;
  readonly mailboxThreads: number;
  readonly labels: number;
  readonly filters: number;
  readonly drafts: number;
  readonly scheduled: number;
  readonly spam: number;
}

interface MailboxThread {
  readonly actorId: string;
  readonly threadId: string;
  lastAt: Date;
  kind: InboundKind | "internal" | "announcement";
  sentByMe: boolean;
  topic: string;
}

type Labels = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Mail: internal conversations go through the send queue and local delivery
 * (the same worker the API runs); external mail goes through SMTP envelope
 * ingest. Mailbox state (read, starred, archived, labels, snoozed, trash, spam)
 * is then applied per person with the thread-state API.
 */
export async function seedMail(
  runtime: DemoRuntime,
  directory: Directory,
  dns: DemoDns,
): Promise<MailSeed> {
  const people = activePeople(directory.people);
  let queuedMessages = 0;
  const mailboxes = new Map<string, MailboxThread>();
  const touch = (
    actorId: string,
    threadId: string,
    at: Date,
    kind: MailboxThread["kind"],
    sentByMe: boolean,
    topic: string,
  ) => {
    const key = `${actorId}:${threadId}`;
    const current = mailboxes.get(key);
    if (current === undefined) {
      mailboxes.set(key, { actorId, threadId, lastAt: at, kind, sentByMe, topic });
    } else if (at > current.lastAt) {
      current.lastAt = at;
      current.sentByMe = sentByMe;
    }
  };

  for (const person of people) {
    await runtime.mail.setUserSettings({
      orgId: runtime.orgId,
      actorId: person.actorId,
      signatureText: signature(person).trimStart(),
      includeSignatureOnReplies: person.index % 3 !== 0,
    });
  }
  const labels = await seedLabels(runtime, people);
  const filters = await seedFilters(runtime, people, labels);

  const sender = new MailSendService({ store: runtime.mail, undoWindowMs: 0 });
  const worker = outboundWorker(runtime);
  const send = async (
    from: Person,
    plan: {
      readonly to: readonly MimeAddress[];
      readonly cc: readonly MimeAddress[];
      readonly subject: string;
      readonly text: string;
      readonly attachments: InternalMessagePlan["attachments"];
      readonly threadId?: string | undefined;
      readonly inReplyTo?: string | undefined;
      readonly references?: readonly string[] | undefined;
      readonly at: Date;
      readonly key: string;
    },
  ) => {
    const rfcMessageId = `<${seedUuid("outbound", plan.key)}@${COMPANY.domain}>`;
    const envelope = {
      from: address(from),
      to: plan.to,
      cc: plan.cc,
      bcc: [],
      subject: plan.subject,
      text: plan.text,
      attachments: plan.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.contentType,
        contentType: attachment.contentType,
        content: attachment.content,
      })),
      messageId: rfcMessageId,
      ...(plan.inReplyTo === undefined ? {} : { inReplyTo: plan.inReplyTo }),
      ...(plan.references === undefined ? {} : { references: plan.references }),
    };
    // Today's mail goes through the live send queue and worker; older mail keeps its date.
    if (runtime.timeline.now.getTime() - plan.at.getTime() < RECENT_MAIL_MS) {
      const queued = await sender.queue({
        orgId: runtime.orgId,
        actorId: from.actorId,
        ...(plan.threadId === undefined ? {} : { threadId: plan.threadId }),
        envelope,
      });
      await deliverNow(runtime, worker, queued.id);
      queuedMessages += 1;
      return { record: { messageId: queued.messageId, threadId: queued.threadId }, rfcMessageId };
    }
    const record = await recordDeliveredMail(runtime, {
      actorId: from.actorId,
      threadId: plan.threadId,
      envelope,
      sentAt: plan.at,
    });
    return { record, rfcMessageId };
  };

  // Internal conversations, each one sequential, many in parallel.
  const conversations = people.flatMap((person) => {
    const random = SeedRandom.stream("mail-internal", person.key);
    const team = people.filter(
      (other) => other.department === person.department && other !== person,
    );
    return Array.from({ length: runtime.preset.mailThreadsPerPerson }, (_, index) => {
      const start = runtime.timeline.recentWorkday(
        random,
        Math.min(person.tenureDays, runtime.timeline.historyDays),
      );
      return {
        person,
        index,
        start,
        plan: internalConversation(person, team, people, start, random),
      };
    });
  });
  let internalMessages = 0;
  await mapLimit(conversations, 6, async ({ person, index, start, plan }) => {
    let threadId: string | undefined;
    const ids: string[] = [];
    for (const [position, message] of plan.messages.entries()) {
      const at = runtime.timeline.clamp(
        new Date(start.getTime() + message.afterMinutes * TIME.MINUTE),
      );
      const subject =
        position === 0
          ? plan.subject
          : message.forward === true
            ? `Fwd: ${plan.subject}`
            : `Re: ${plan.subject}`;
      const { record, rfcMessageId } = await send(message.from, {
        to: message.to,
        cc: message.cc,
        subject,
        text: message.body,
        attachments: message.attachments,
        ...(threadId === undefined || message.forward === true ? {} : { threadId }),
        ...(ids.length === 0 || message.forward === true
          ? {}
          : { inReplyTo: ids.at(-1), references: ids }),
        at,
        key: `${person.key}:${String(index)}:${String(position)}`,
      });
      if (message.forward !== true) {
        threadId ??= record.threadId;
        ids.push(rfcMessageId);
      }
      internalMessages += 1;
      const recipients = [...message.to, ...message.cc].map((entry) => entry.address.toLowerCase());
      for (const other of people) {
        if (recipients.includes(companyMailbox(other).toLowerCase())) {
          touch(other.actorId, record.threadId, at, "internal", false, plan.subject);
        }
      }
      touch(message.from.actorId, record.threadId, at, "internal", true, plan.subject);
    }
  });

  // Company announcements to the all-staff distribution list.
  const allStaff = directory.groups.get("all-staff");
  const announcers = people
    .filter((person) => person.key === "person-0" || person.department === "people")
    .slice(0, 2);
  const announcementRandom = SeedRandom.stream("mail-announcements");
  if (allStaff?.email != null) {
    for (
      let index = 0;
      index < Math.floor(runtime.timeline.historyDays / (runtime.size === "small" ? 120 : 45));
      index += 1
    ) {
      const author = announcementRandom.pick(announcers);
      const at = runtime.timeline.workday(
        announcementRandom,
        index * (runtime.size === "small" ? 120 : 45) + announcementRandom.int(0, 10),
      );
      const content = announcement(author, at, announcementRandom);
      const { record } = await send(author, {
        to: [{ address: allStaff.email, name: allStaff.name }],
        cc: [],
        subject: content.subject,
        text: content.text,
        attachments: [],
        at,
        key: `announcement:${String(index)}`,
      });
      internalMessages += 1;
      for (const memberId of allStaff.memberIds)
        touch(
          memberId,
          record.threadId,
          at,
          "announcement",
          memberId === author.actorId,
          content.subject,
        );
    }
  }

  // External mail through SMTP ingest.
  const desk = new InboundMailDesk(runtime, dns);
  const plans = inboundPlans(runtime, directory);
  const deliveries = await mapLimit(plans, 8, (plan) => desk.deliver(plan));
  const customers = await mapLimit(customerPlans(runtime, directory), 4, async (plan) => {
    const delivered = await desk.deliver(plan);
    return { plan, delivered };
  });
  for (const delivery of [...deliveries, ...customers.map((entry) => entry.delivered)]) {
    for (const actorId of delivery.mailboxIds)
      touch(actorId, delivery.threadId, delivery.at, delivery.kind, false, delivery.entity.name);
  }
  // Support and sales answer customers from the shared inbox; customers write back.
  const replyRandom = SeedRandom.stream("mail-customer-replies");
  for (const { plan, delivered } of customers) {
    const responders = people.filter((person) => delivered.mailboxIds.includes(person.actorId));
    if (responders.length === 0 || !replyRandom.chance(0.8)) continue;
    const responder = replyRandom.pick(responders);
    const at = runtime.timeline.clamp(
      new Date(delivered.at.getTime() + replyRandom.int(20, 600) * TIME.MINUTE),
    );
    const customer = externalAddress(plan.plan.entity, plan.plan.senderIndex);
    const { record, rfcMessageId } = await send(responder, {
      to: [customer],
      cc: [],
      subject: `Re: ${plan.plan.subject}`,
      text: `Hi ${customer.name.split(" ")[0] ?? ""},\n\nThanks for reaching out. ${replyRandom.pick(
        [
          "I've reproduced the issue and our routing team is on it; I'll update you by end of day.",
          "Yes — you can export that from Reports > Exports. I've attached nothing yet, but here are the steps.",
          "Adding depots is self-serve under Settings > Depots. Happy to walk through it on a call.",
          "I've updated the invoice address on your account. The next invoice will reflect it.",
        ],
      )}${signature(responder)}`,
      attachments: [],
      threadId: delivered.threadId,
      inReplyTo: delivered.rfcMessageId,
      references: [delivered.rfcMessageId],
      at,
      key: `customer-reply:${delivered.messageId}`,
    });
    touch(responder.actorId, record.threadId, at, "customer", true, plan.plan.entity.name);
    if (replyRandom.chance(0.5)) {
      const followUpAt = runtime.timeline.clamp(
        new Date(at.getTime() + replyRandom.int(60, 2 * 24 * 60) * TIME.MINUTE),
      );
      const followUp = await desk.deliver({
        kind: "customer",
        plan: {
          ...plan.plan,
          subject: `Re: ${plan.plan.subject}`,
          text: `Thank you, that solved it!\n\n${customer.name}`,
        },
        to: plan.to,
        at: followUpAt,
        inReplyTo: rfcMessageId,
        references: [delivered.rfcMessageId, rfcMessageId],
      });
      for (const actorId of followUp.mailboxIds)
        touch(actorId, followUp.threadId, followUpAt, "customer", false, plan.plan.entity.name);
    }
  }

  const drafts = await seedDrafts(runtime, people);
  const scheduled = await seedScheduledSends(runtime, people, sender);
  const spam = await applyMailboxState(runtime, [...mailboxes.values()], labels, people);
  await seedVacation(runtime, people);
  return {
    internalThreads: conversations.length,
    internalMessages,
    queuedMessages,
    inboundMessages: deliveries.length + customers.length,
    mailboxThreads: mailboxes.size,
    labels: [...labels.values()].reduce((sum, entry) => sum + entry.size, 0),
    filters,
    drafts,
    scheduled,
    spam,
  };
}

/**
 * Drains the queue until this message has left it, so a reply is only written
 * once its recipients have the thread. Parallel conversations share the queue,
 * so another drain may be holding this message's lease for a moment.
 */
async function deliverNow(
  runtime: DemoRuntime,
  worker: OutboundMailWorker,
  outboundId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await worker.drainOnce();
    const outbound = await runtime.tenant(() => runtime.rawMail.getOutbound(outboundId));
    if (outbound !== null && outbound.status !== "queued" && outbound.status !== "sending") {
      if (outbound.status !== "accepted" && outbound.status !== "delivered") {
        throw new DemoSeedError(
          `Outbound mail ${outboundId} ended as ${outbound.status}: ${outbound.lastError ?? "no error recorded"}.`,
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new DemoSeedError(
    `Outbound mail ${outboundId} was not delivered; check the outbound worker logs.`,
  );
}

/** The API's outbound worker: local recipients get local delivery, the rest the relay. */
function outboundWorker(runtime: DemoRuntime): OutboundMailWorker {
  const sql = runtime.sql;
  return new OutboundMailWorker({
    store: tenantMailClaims(sql, runtime.rawMail),
    batchSize: 50,
    dispatcher: new OutboundMailDispatcher(
      runtime.rawMail,
      async (outbound) => new LocalMailTransport(sql, outbound, async () => demoRelay),
      {
        runForTenant: (orgId, operation) => withTenantPostgresContext(sql, { orgId }, operation),
        resolveAttachment: async (objectId, context) => {
          const staged = await runtime.mailIngestor.openAttached({ ...context, objectId });
          if (staged === null)
            throw new DemoSeedError(`Mail attachment ${objectId} is not staged.`);
          return staged;
        },
      },
    ),
  });
}

async function seedLabels(runtime: DemoRuntime, people: readonly Person[]): Promise<Labels> {
  const result = new Map<string, Map<string, string>>();
  for (const person of people) {
    const random = SeedRandom.stream("mail-labels", person.key);
    const names = new Map<string, string>();
    const create = async (name: string, parentId: string | null, color: MailLabelColorName) => {
      const label = await runtime.mail.createLabel({
        orgId: runtime.orgId,
        actorId: person.actorId,
        name,
        color,
        parentId,
      });
      names.set(
        parentId === null
          ? name
          : `${[...names.entries()].find(([, id]) => id === parentId)?.[0] ?? ""}/${name}`,
        label.slug,
      );
      return label;
    };
    const pick = () => random.pick(MAIL_LABEL_COLOR_NAMES);
    await create("Receipts", null, "green");
    await create("Newsletters", null, "sky");
    if (person.department === "sales" || person.department === "support")
      await create("Customers", null, "orange");
    if (person.department === "finance") await create("Invoices", null, "amber");
    if (random.chance(0.7)) {
      const projects = await create("Projects", null, pick());
      for (const feature of random.sample(FEATURES, random.int(1, 3))) {
        const name = feature.charAt(0).toUpperCase() + feature.slice(1);
        const label = await runtime.mail.createLabel({
          orgId: runtime.orgId,
          actorId: person.actorId,
          name,
          color: pick(),
          parentId: projects.id,
        });
        names.set(`Projects/${name}`, label.slug);
      }
    }
    if (random.chance(0.3)) await create("Travel", null, "violet");
    if (random.chance(0.25)) await create("Follow up", null, "red");
    result.set(person.actorId, names);
  }
  return result;
}

/** Filters exist before the mail arrives, so ingest applies them for real. */
async function seedFilters(
  runtime: DemoRuntime,
  people: readonly Person[],
  labels: Labels,
): Promise<number> {
  let count = 0;
  for (const person of people.filter((entry) => entry.index % 2 === 0)) {
    const mine = labels.get(person.actorId);
    const newsletters = mine?.get("Newsletters");
    const receipts = mine?.get("Receipts");
    if (newsletters !== undefined) {
      for (const list of NEWSLETTERS.filter((_, index) => (index + person.index) % 3 === 0)) {
        await runtime.mail.createFilter({
          orgId: runtime.orgId,
          actorId: person.actorId,
          name: `${list.name} → Newsletters`,
          criteria: { fromContains: list.domain },
          actions: { applyLabels: [newsletters], archive: person.index % 4 === 0, markRead: false },
        });
        count += 1;
      }
    }
    if (receipts !== undefined) {
      await runtime.mail.createFilter({
        orgId: runtime.orgId,
        actorId: person.actorId,
        name: "Receipts",
        criteria: { subjectContains: "receipt" },
        actions: { applyLabels: [receipts] },
      });
      count += 1;
    }
  }
  return count;
}

async function seedDrafts(runtime: DemoRuntime, people: readonly Person[]): Promise<number> {
  let count = 0;
  for (const person of people.filter((entry) => entry.login !== null || entry.index % 9 === 2)) {
    const random = SeedRandom.stream("mail-drafts", person.key);
    for (let index = 0; index < (person.login === null ? 1 : 3); index += 1) {
      const colleague = random.pick(people.filter((other) => other !== person));
      await runtime.mail.saveDraft({
        orgId: runtime.orgId,
        actorId: person.actorId,
        idempotencyKey: seedUuid("draft", person.key, index),
        attachmentObjectIds: [],
        envelope: {
          to: [address(colleague)],
          subject: random.pick([
            "Quick question about the rollout",
            "Notes from today",
            "Re: budget follow-up",
            "Draft: launch announcement",
          ]),
          text: `Hi ${colleague.givenName},\n\n${random.pick(["I wanted to check whether", "Following up on", "Before Thursday, could we"])} `,
        },
      });
      count += 1;
    }
  }
  return count;
}

async function seedScheduledSends(
  runtime: DemoRuntime,
  people: readonly Person[],
  sender: MailSendService,
): Promise<number> {
  let count = 0;
  for (const person of people.filter((entry) => entry.login !== null)) {
    const team = people.filter(
      (other) => other.department === person.department && other !== person,
    );
    for (const [days, subject] of [
      [1, "Reminder: send me your Q-end numbers"],
      [3, "Agenda for next week's planning"],
    ] as const) {
      const recipient = team[count % Math.max(team.length, 1)] ?? people[0];
      if (recipient === undefined) continue;
      const sendAt = new Date(runtime.timeline.now.getTime() + days * TIME.DAY);
      sendAt.setUTCHours(13, 0, 0, 0);
      await sender.queue({
        orgId: runtime.orgId,
        actorId: person.actorId,
        sendAt,
        envelope: {
          from: address(person),
          to: [address(recipient)],
          cc: [],
          bcc: [],
          subject,
          text: `Hi ${recipient.givenName},\n\nJust a reminder about this.${signature(person)}`,
          attachments: [],
          messageId: `<${seedUuid("scheduled", person.key, days)}@${COMPANY.domain}>`,
        },
      });
      count += 1;
    }
  }
  return count;
}

/** One person is on leave this week, with an auto-reply. Set last so history gets no replies. */
async function seedVacation(runtime: DemoRuntime, people: readonly Person[]): Promise<void> {
  const person =
    people.find((entry) => entry.department === "marketing" && entry.managerKey !== "person-0") ??
    people[3];
  if (person === undefined) return;
  await runtime.mail.setVacation({
    orgId: runtime.orgId,
    actorId: person.actorId,
    enabled: true,
    subject: "Out of office until next week",
    body: `Hi,\n\nI'm away with limited access to email and will reply when I'm back. For anything urgent, please write to the marketing team.\n\n${person.displayName}`,
    startsAt: new Date(runtime.timeline.now.getTime() - 3 * TIME.DAY),
    endsAt: new Date(runtime.timeline.now.getTime() + 6 * TIME.DAY),
    metadata: { contactsOnly: false },
  });
}

/** Read, starred, archived, labelled, snoozed, trashed and spam-reported threads. */
async function applyMailboxState(
  runtime: DemoRuntime,
  threads: readonly MailboxThread[],
  labels: Labels,
  people: readonly Person[],
): Promise<number> {
  const now = runtime.timeline.now.getTime();
  const logins = new Set(
    people.filter((person) => person.login !== null).map((person) => person.actorId),
  );
  const snoozedPerLogin = new Map<string, number>();
  let spam = 0;
  await mapLimit(threads, 8, async (thread) => {
    const random = SeedRandom.stream("mail-state", thread.actorId, thread.threadId);
    const ageDays = (now - thread.lastAt.getTime()) / TIME.DAY;
    const mine = labels.get(thread.actorId);
    const patch: {
      addLabels?: string[];
      readAt?: Date;
      starred?: boolean;
      archivedAt?: Date;
      deletedAt?: Date;
      snoozedUntil?: Date;
      spamAt?: Date;
    } = {};
    if (thread.kind === "spam") {
      patch.spamAt = new Date(thread.lastAt.getTime() + random.int(5, 600) * TIME.MINUTE);
      await runtime.mail.updateThreadState({
        orgId: runtime.orgId,
        actorId: thread.actorId,
        threadId: thread.threadId,
        patch,
      });
      await runtime.mail.recordSpamFeedback({
        orgId: runtime.orgId,
        actorId: thread.actorId,
        threadId: thread.threadId,
        label: "spam",
        source: "user",
      });
      spam += 1;
      return;
    }
    const unreadChance = ageDays < 2 ? 0.65 : ageDays < 10 ? 0.25 : ageDays < 60 ? 0.06 : 0.01;
    if (
      thread.sentByMe ||
      !random.chance(
        thread.kind === "newsletter" || thread.kind === "promotion"
          ? unreadChance * 2
          : unreadChance,
      )
    ) {
      patch.readAt = runtime.timeline.clamp(
        new Date(thread.lastAt.getTime() + random.int(1, 240) * TIME.MINUTE),
      );
    }
    const label =
      thread.kind === "receipt"
        ? mine?.get("Receipts")
        : thread.kind === "newsletter"
          ? mine?.get("Newsletters")
          : thread.kind === "invoice"
            ? mine?.get("Invoices")
            : thread.kind === "customer"
              ? mine?.get("Customers")
              : thread.kind === "internal" && random.chance(0.25)
                ? [...(mine?.entries() ?? [])].find(([name]) => name.startsWith("Projects/"))?.[1]
                : undefined;
    if (label !== undefined) patch.addLabels = [label];
    if (random.chance(thread.kind === "internal" || thread.kind === "customer" ? 0.06 : 0.01))
      patch.starred = true;
    if (ageDays > 14 && random.chance(thread.kind === "internal" ? 0.5 : 0.35)) {
      patch.archivedAt = new Date(thread.lastAt.getTime() + random.int(1, 9) * TIME.DAY);
    }
    if (ageDays < 25 && random.chance(0.02))
      patch.deletedAt = runtime.timeline.clamp(
        new Date(thread.lastAt.getTime() + random.int(1, 48) * TIME.HOUR),
      );
    const snoozed = snoozedPerLogin.get(thread.actorId) ?? 0;
    if (
      logins.has(thread.actorId) &&
      snoozed < 2 &&
      ageDays < 10 &&
      thread.kind === "internal" &&
      patch.deletedAt === undefined
    ) {
      snoozedPerLogin.set(thread.actorId, snoozed + 1);
      patch.snoozedUntil = new Date(now + (snoozed + 1) * 2 * TIME.DAY);
      delete patch.archivedAt;
    }
    if (Object.keys(patch).length > 0) {
      await runtime.mail.updateThreadState({
        orgId: runtime.orgId,
        actorId: thread.actorId,
        threadId: thread.threadId,
        patch,
      });
    }
  });
  return spam;
}

/**
 * Lines up everything derived from a message's time with the message: delivery
 * receipts, thread first/last activity, mailbox ordering, and the stored raw
 * sources and attachments.
 */
export async function alignMailTimeline(tx: postgres.TransactionSql, orgId: string): Promise<void> {
  await tx`
    update mail_message_deliveries delivery
    set received_at = message.sent_at + interval '4 seconds'
    from messages message
    where delivery.org_id = ${orgId} and message.id = delivery.message_id and delivery.received_at is not null
  `;
  await tx`
    update threads thread
    set created_at = span.first_at, updated_at = span.last_at
    from (
      select thread_id, min(sent_at) as first_at, max(sent_at) as last_at
      from messages where org_id = ${orgId} and kind = 'mail' group by thread_id
    ) span
    where thread.org_id = ${orgId} and thread.id = span.thread_id
  `;
  await tx`
    update mail_thread_state state
    set updated_at = greatest(thread.updated_at, coalesce(state.read_at, thread.updated_at))
    from threads thread
    where state.org_id = ${orgId} and thread.id = state.thread_id
  `;
  await tx`
    update objects object
    set created_at = message.sent_at, updated_at = message.sent_at
    from message_attachments attachment
    join messages message on message.id = attachment.message_id
    where object.org_id = ${orgId} and attachment.org_id = ${orgId} and object.id = attachment.object_id
      and object.kind = 'mail_attachment'
  `;
  await tx`
    update objects object
    set created_at = message.sent_at, updated_at = message.sent_at
    from mail_raw_sources source
    join messages message on message.id = source.message_id
    where object.org_id = ${orgId} and source.org_id = ${orgId} and object.id = source.object_id
  `;
}
