import { CalendarInvitationImporter } from "../../platform/calendar/invitation-import.js";
import { ingestRawMail, resolvedMailRecipients } from "../../platform/mail/ingest.js";
import type { MailInboundRecipient } from "../../platform/mail/types.js";
import { withTenantPostgresContext } from "../../platform/tenancy/postgres-roles.js";
import { activePeople, COMPANY, type Person } from "./company.js";
import type { DemoDns } from "./dns.js";
import type { Directory } from "./directory.js";
import {
  customerQuestion,
  invitation,
  newsletter,
  promotion,
  receipt,
  securityNotice,
  shippingNotice,
  spamMessage,
  vendorInvoice,
  type ExternalMessagePlan,
} from "./mail-content.js";
import { DemoMailAuthenticator, DemoMailServers, type MimeAddress } from "./mail-mime.js";
import { SeedRandom, seedUuid, TIME } from "./random.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";
import {
  CUSTOMERS,
  NEWSLETTERS,
  PROMOTERS,
  SPAMMERS,
  VENDORS,
  externalAddress,
  type ExternalOrg,
} from "./world.js";

export type InboundKind =
  | "newsletter"
  | "promotion"
  | "receipt"
  | "invoice"
  | "customer"
  | "invite"
  | "shipping"
  | "security"
  | "spam";

export interface InboundDelivery {
  readonly kind: InboundKind;
  readonly messageId: string;
  readonly threadId: string;
  readonly rfcMessageId: string;
  readonly at: Date;
  readonly mailboxIds: readonly string[];
  readonly entity: ExternalOrg;
}

export interface InboundPlan {
  readonly kind: InboundKind;
  readonly plan: ExternalMessagePlan;
  readonly to: readonly string[];
  readonly at: Date;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

/**
 * Delivers external mail the way the SMTP receiver does: RCPT resolution
 * (including group fan-out), SPF/DKIM/DMARC verification, ClamAV, raw-source
 * evidence, attachment staging, inbound filters and iMIP import.
 */
export class InboundMailDesk {
  readonly #servers: DemoMailServers;
  readonly #authenticator: DemoMailAuthenticator;
  readonly #invitations: CalendarInvitationImporter;

  constructor(
    private readonly runtime: DemoRuntime,
    dns: DemoDns,
  ) {
    this.#servers = new DemoMailServers(dns);
    for (const entity of [...CUSTOMERS, ...VENDORS, ...NEWSLETTERS, ...PROMOTERS]) {
      this.#servers.register(entity, { signed: true, dmarc: true });
    }
    for (const entity of SPAMMERS) this.#servers.register(entity, { signed: false, dmarc: false });
    this.#authenticator = new DemoMailAuthenticator(dns);
    this.#invitations = new CalendarInvitationImporter({
      sql: runtime.sql,
      store: runtime.rawCalendar,
      isEnabled: async (orgId) =>
        (await runtime.orgs.findById(orgId))?.featureFlags.calendar_import_invitations === true,
    });
  }

  async deliver(item: InboundPlan): Promise<InboundDelivery> {
    const sender = externalAddress(item.plan.entity, item.plan.senderIndex);
    const rfcMessageId = `<${seedUuid("inbound", item.kind, item.to.join(","), item.at.toISOString(), item.plan.subject)}@${item.plan.entity.domain}>`;
    const raw = await this.#servers.render(
      {
        from: sender,
        to: item.to.map((address) => ({ address, name: "" })),
        subject: item.plan.subject,
        text: item.plan.text,
        ...(item.plan.html === undefined ? {} : { html: item.plan.html }),
        date: item.at,
        messageId: rfcMessageId,
        ...(item.inReplyTo === undefined ? {} : { inReplyTo: item.inReplyTo }),
        ...(item.references === undefined ? {} : { references: item.references }),
        attachments: item.plan.attachments,
        ...(item.plan.headers === undefined ? {} : { headers: item.plan.headers }),
        ...(item.plan.icalEvent === undefined ? {} : { icalEvent: item.plan.icalEvent }),
      },
      item.plan.entity,
    );
    // RCPT resolution exactly as the SMTP receiver does it, group fan-out included.
    const recipients = new Map<string, MailInboundRecipient>();
    for (const address of item.to) {
      for (const recipient of resolvedMailRecipients(
        await this.runtime.rawMail.resolveInboundAddress(address),
      )) {
        recipients.set(recipient.actorId, recipient);
      }
    }
    if (recipients.size === 0) {
      throw new DemoSeedError(
        `No mailbox accepts ${item.to.join(", ")}; check the receiving domains and groups.`,
      );
    }
    const result = await withTenantPostgresContext(
      this.runtime.sql,
      { orgId: this.runtime.orgId },
      () =>
        ingestRawMail({
          store: this.runtime.rawMail,
          authenticator: this.#authenticator,
          // A personal-tier tenant without spamd: ClamAV scans, a missing spam scanner does not defer.
          scanners: {
            tier: "personal",
            antivirus: this.runtime.mailScanner,
            failurePolicy: "deliver",
          },
          malwareDisposition: "reject",
          calendarInvitations: this.#invitations,
          input: {
            orgId: this.runtime.orgId,
            recipients: [...recipients.values()],
            raw,
            envelopeFrom: `bounces@${item.plan.entity.domain}`,
            remoteAddress: item.plan.entity.ip,
            helo: `mail.${item.plan.entity.domain}`,
            receivedAt: item.at,
          },
        }),
    );
    return {
      kind: item.kind,
      messageId: result.stored.messageId,
      threadId: result.stored.threadId,
      rfcMessageId,
      at: item.at,
      mailboxIds: result.stored.deliveredActorIds,
      entity: item.plan.entity,
    };
  }
}

/** The external mail each person receives over the company's history. */
export function inboundPlans(runtime: DemoRuntime, directory: Directory): InboundPlan[] {
  const people = activePeople(directory.people);
  const plans: InboundPlan[] = [];
  const timeline = runtime.timeline;
  const groupAddress = (key: string) => {
    const email = directory.groups.get(key)?.email;
    if (email === undefined || email === null)
      throw new DemoSeedError(`Group ${key} has no address.`);
    return email;
  };
  for (const person of people) {
    const random = SeedRandom.stream("inbound", person.key);
    const since = Math.min(person.tenureDays, timeline.historyDays);
    const subscriptions = random.sample(NEWSLETTERS, random.int(1, 2));
    const count = runtime.preset.inboundPerPerson;
    for (let index = 0; index < count; index += 1) {
      const at = timeline.recentWorkday(random, since);
      const kind = random.weighted<InboundKind>([
        ["newsletter", 6],
        ["promotion", 2],
        ["receipt", 3],
        ["shipping", 1],
        ["security", 1],
        ["spam", index === 0 && person.index % 4 === 0 ? 40 : 0.4],
      ]);
      const to = [companyMailbox(person)];
      switch (kind) {
        case "newsletter":
          plans.push({ kind, plan: newsletter(random.pick(subscriptions), at, random), to, at });
          break;
        case "promotion":
          plans.push({ kind, plan: promotion(random.pick(PROMOTERS), random), to, at });
          break;
        case "receipt":
          plans.push({
            kind,
            plan: receipt(
              random.pick(
                VENDORS.filter((vendor) =>
                  ["skylark", "staybright", "quickcab", "officecrate"].includes(vendor.key),
                ),
              ),
              person,
              at,
              random,
            ),
            to,
            at,
          });
          break;
        case "shipping":
          plans.push({
            kind,
            plan: shippingNotice(
              VENDORS.find((vendor) => vendor.key === "parcelpost") as ExternalOrg,
              person,
              random,
            ),
            to,
            at,
          });
          break;
        case "security":
          plans.push({
            kind,
            plan: securityNotice(random.pick(VENDORS), person),
            to,
            at: timeline.offHours(random, since),
          });
          break;
        default:
          plans.push({
            kind: "spam",
            plan: spamMessage(random.pick(SPAMMERS), random),
            to,
            at: timeline.offHours(random, since),
          });
      }
    }
  }
  // Vendor invoices to the billing list, roughly monthly per active vendor.
  const random = SeedRandom.stream("inbound-billing");
  const months = Math.floor(timeline.historyDays / 30);
  for (const vendor of VENDORS.filter((entry) =>
    ["ledgerly", "cloudcabin", "tessera", "bluegate", "brewline", "printhouse"].includes(entry.key),
  )) {
    for (let month = 0; month < months; month += 1) {
      if (!random.chance(runtime.size === "small" ? 0.25 : 0.7)) continue;
      const at = timeline.workday(random, month * 30 + random.int(0, 6));
      plans.push({
        kind: "invoice",
        plan: vendorInvoice(vendor, at, random),
        to: [groupAddress("billing")],
        at,
      });
    }
  }
  // Partner invitations to account executives, imported into their calendars.
  const sales = people.filter((person) => person.department === "sales");
  for (const [index, customer] of CUSTOMERS.entries()) {
    const attendee = sales[index % Math.max(sales.length, 1)];
    if (attendee === undefined) continue;
    const start = new Date(timeline.now.getTime() + random.int(-20, 14) * TIME.DAY);
    start.setUTCHours(random.int(14, 20), random.pick([0, 30]), 0, 0);
    const organizer: MimeAddress = externalAddress(customer, 0);
    plans.push({
      kind: "invite",
      plan: invitation(
        customer,
        organizer,
        attendee,
        start,
        `${seedUuid("imip", customer.key)}@${customer.domain}`,
      ),
      to: [companyMailbox(attendee)],
      at: new Date(
        Math.min(start.getTime() - random.int(2, 9) * TIME.DAY, timeline.now.getTime() - TIME.HOUR),
      ),
    });
  }
  return plans;
}

/** Customer questions to the shared support and sales inboxes. */
export function customerPlans(runtime: DemoRuntime, directory: Directory): InboundPlan[] {
  const random = SeedRandom.stream("inbound-customers");
  const supportAddress = directory.groups.get("support-inbox")?.email;
  const salesAddress = directory.groups.get("sales-inbox")?.email;
  if (supportAddress == null || salesAddress == null)
    throw new DemoSeedError("Support and sales inboxes are missing.");
  const count = Math.round(
    activePeople(directory.people).length *
      (runtime.size === "small" ? 0.3 : runtime.size === "medium" ? 1 : 2.5),
  );
  return Array.from({ length: count }, () => {
    const at = runtime.timeline.recentWorkday(random, 360);
    return {
      kind: "customer" as const,
      plan: customerQuestion(random.pick(CUSTOMERS), random),
      to: [random.chance(0.75) ? supportAddress : salesAddress],
      at,
    };
  });
}

/** The address external senders know someone by. */
export function companyMailbox(person: Person): string {
  return person.aliases[0] ?? person.email.replace(/@.*$/u, `@${COMPANY.domain}`);
}
