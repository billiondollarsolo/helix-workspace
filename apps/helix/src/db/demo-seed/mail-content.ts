import { COMPANY, companyAddress, type Person } from "./company.js";
import { barChartPng, csv, money, simplePdf } from "./files.js";
import type { MimeAddress, MimeAttachment } from "./mail-mime.js";
import { TIME, type SeedRandom } from "./random.js";
import {
  CAMPAIGNS,
  CUSTOMERS,
  FEATURES,
  LUNCH_SPOTS,
  SERVICES,
  externalAddress,
  monthName,
  quarterLabel,
  type ExternalOrg,
} from "./world.js";

export interface InternalMessagePlan {
  readonly from: Person;
  readonly to: readonly MimeAddress[];
  readonly cc: readonly MimeAddress[];
  readonly body: string;
  readonly attachments: readonly MimeAttachment[];
  /** Offset from the conversation start, in minutes. */
  readonly afterMinutes: number;
  readonly forward?: boolean;
}

export interface InternalConversation {
  readonly subject: string;
  readonly messages: readonly InternalMessagePlan[];
}

export function address(person: Person): MimeAddress {
  return { address: companyAddress(person), name: person.displayName };
}

export function signature(person: Person): string {
  return `\n\n--\n${person.displayName}\n${person.jobTitle} · ${COMPANY.name}`;
}

function body(person: Person, lines: readonly string[]): string {
  return `${lines.join("\n")}${signature(person)}`;
}

function quote(previous: InternalMessagePlan, date: string): string {
  const quoted = previous.body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${date}, ${previous.from.displayName} wrote:\n${quoted}`;
}

const REPLIES = [
  "Thanks — this looks good to me.",
  "Makes sense. I'll pick this up tomorrow morning.",
  "Can we talk about this at the weekly? I have a couple of questions.",
  "Agreed. Let's go with option B.",
  "Done. I updated the doc in the team drive.",
  "Looping in the right people here.",
  "Small correction: the numbers in the second table are from last month.",
  "+1. No concerns from my side.",
  "I can take the first draft. Expect something by Thursday.",
  "Not yet — still waiting on the customer's IT team.",
];

/** One internal conversation started by `author` on a theme from their job. */
export function internalConversation(
  author: Person,
  team: readonly Person[],
  everyone: readonly Person[],
  start: Date,
  random: SeedRandom,
): InternalConversation {
  const peer =
    team.length > 0
      ? random.pick(team)
      : random.pick(everyone.filter((person) => person !== author));
  const others = random.sample(
    everyone.filter((person) => person !== author && person !== peer),
    random.int(0, 2),
  );
  const feature = random.pick(FEATURES);
  const customer = random.pick(CUSTOMERS);
  const service = random.pick(SERVICES);
  const date = start.toISOString().slice(0, 10);
  const themes: (() => InternalConversation)[] = [
    () => ({
      subject: `${capital(feature)}: next steps`,
      messages: [
        {
          from: author,
          to: [address(peer)],
          cc: others.map(address),
          body: body(author, [
            `Hi ${peer.givenName},`,
            "",
            `Following up on yesterday's discussion about ${feature}. I think we should split it into two milestones:`,
            "1. The smallest version our pilot customers asked for.",
            "2. The reporting pieces, once we see how people use it.",
            "",
            "Does that work for you? Happy to adjust.",
          ]),
          attachments: [],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: `Escalation: ${customer.name} — ${service} errors`,
      messages: [
        {
          from: author,
          to: [address(peer)],
          cc: others.map(address),
          body: body(author, [
            `${peer.givenName} — ${customer.name} reported intermittent errors from ${service} this morning.`,
            "Ticket volume from them tripled in two hours. Can someone on your side take a look?",
            "",
            "Timeline and screenshots are in the escalation doc.",
          ]),
          attachments: random.chance(0.5)
            ? [
                {
                  filename: "error-rate.png",
                  contentType: "image/png",
                  content: barChartPng([3, 4, 2, 18, 27, 9, 4], `${date}${customer.key}`),
                },
              ]
            : [],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: `Contract review: ${customer.name} renewal`,
      messages: [
        {
          from: author,
          to: [address(peer)],
          cc: others.map(address),
          body: body(author, [
            `Hi ${peer.givenName},`,
            "",
            `${customer.name} sent back redlines on the renewal. The main asks are a 60-day termination for convenience and a cap on price increases.`,
            "Could you review before Friday? Their procurement team wants to sign this quarter.",
          ]),
          attachments: [
            {
              filename: `${customer.name} redlines.pdf`,
              contentType: "application/pdf",
              content: simplePdf(`${customer.name} — renewal redlines`, [
                "Section 4.2: termination for convenience on 60 days notice.",
                "Section 7.1: annual price increase capped at 5%.",
                "Section 9: data retention 90 days after termination.",
              ]),
            },
          ],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: `Expense report — ${monthName(start)}`,
      messages: [
        {
          from: author,
          to: [address(peer)],
          cc: [],
          body: body(author, [
            `Hi ${peer.givenName},`,
            "",
            `Attached is my expense report for ${monthName(start)}: the ${customer.name} visit and two team lunches.`,
            "Receipts are in the folder linked in the sheet.",
          ]),
          attachments: [
            {
              filename: `expenses-${date}.csv`,
              contentType: "text/csv",
              content: csv([
                ["date", "description", "amount_usd"],
                [date, `Train to ${customer.name}`, (random.int(4000, 19000) / 100).toFixed(2)],
                [date, "Team lunch", (random.int(6000, 24000) / 100).toFixed(2)],
              ]),
            },
          ],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: `Weekly update — ${author.team} — week of ${date}`,
      messages: [
        {
          from: author,
          to: [address(peer), ...others.map(address)],
          cc: [],
          body: body(author, [
            "Highlights this week:",
            `- Shipped the first slice of ${feature}.`,
            `- Closed ${String(random.int(4, 19))} bugs, ${String(random.int(0, 3))} still open from the last release.`,
            `- ${customer.name} onboarding is on track.`,
            "",
            "Risks: one teammate out next week, so the dashboard work slips by a few days.",
          ]),
          attachments: random.chance(0.4)
            ? [
                {
                  filename: "burndown.png",
                  contentType: "image/png",
                  content: barChartPng([21, 18, 16, 11, 9, 5, 2], `${date}${author.key}`),
                },
              ]
            : [],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: random.pick(["Lunch Thursday?", "Team lunch", "Celebrating the launch"]),
      messages: [
        {
          from: author,
          to: [address(peer), ...others.map(address)],
          cc: [],
          body: body(author, [
            `Anyone up for ${random.pick(LUNCH_SPOTS)} on Thursday at 12:30?`,
            "I'll book a table if at least four of us can make it.",
          ]),
          attachments: [],
          afterMinutes: 0,
        },
      ],
    }),
    () => ({
      subject: `${quarterLabel(start)} planning: ${author.team} priorities`,
      messages: [
        {
          from: author,
          to: [address(peer)],
          cc: others.map(address),
          body: body(author, [
            `Draft priorities for ${quarterLabel(start)} attached. Top three:`,
            `1. ${capital(feature)}`,
            `2. Reliability work on ${service}`,
            "3. Hiring two people for the team",
            "",
            "Comments welcome before the leadership review.",
          ]),
          attachments: [
            {
              filename: `${author.team} priorities ${quarterLabel(start)}.csv`,
              contentType: "text/csv",
              content: csv([
                ["priority", "initiative", "confidence"],
                [1, capital(feature), "high"],
                [2, `Reliability: ${service}`, "medium"],
                [3, "Hiring", "medium"],
              ]),
            },
          ],
          afterMinutes: 0,
        },
      ],
    }),
  ];
  const opening = random.pick(themes)();
  const messages: InternalMessagePlan[] = [...opening.messages];
  const replies = random.weighted<number>([
    [0, 3],
    [1, 4],
    [2, 3],
    [3, 2],
    [5, 1],
  ]);
  let elapsed = 0;
  // Only people who received the opening message can reply in its thread.
  const first = opening.messages[0];
  const reached = new Set(
    [...(first?.to ?? []), ...(first?.cc ?? [])].map((entry) => entry.address),
  );
  const participants = [
    author,
    ...[peer, ...others].filter((person) => reached.has(address(person).address)),
  ];
  for (let reply = 0; reply < replies; reply += 1) {
    const previous = messages.at(-1) as InternalMessagePlan;
    const sender = random.pick(participants.filter((person) => person !== previous.from));
    elapsed += random.int(8, 26 * 60);
    messages.push({
      from: sender,
      to: [address(previous.from)],
      cc: participants
        .filter((person) => person !== sender && person !== previous.from)
        .map(address),
      body: `${body(sender, [random.pick(REPLIES)])}${quote(previous, new Date(start.getTime() + elapsed * TIME.MINUTE).toUTCString())}`,
      attachments: [],
      afterMinutes: elapsed,
    });
  }
  if (random.chance(0.12)) {
    const forwarder = random.pick(participants);
    const target = random.pick(everyone.filter((person) => !participants.includes(person)));
    elapsed += random.int(60, 3 * 24 * 60);
    const first = messages[0] as InternalMessagePlan;
    messages.push({
      from: forwarder,
      to: [address(target)],
      cc: [],
      body: `${body(forwarder, [`${target.givenName}, FYI — see below. Relevant for your team.`])}\n\n---------- Forwarded message ---------\nFrom: ${first.from.displayName}\nSubject: ${opening.subject}\n\n${first.body}`,
      attachments: first.attachments,
      afterMinutes: elapsed,
      forward: true,
    });
  }
  return { subject: opening.subject, messages };
}

export interface ExternalMessagePlan {
  readonly entity: ExternalOrg;
  readonly senderIndex: number;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments: readonly MimeAttachment[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly icalEvent?: { readonly method: string; readonly content: string };
}

export function newsletter(
  entity: ExternalOrg,
  when: Date,
  random: SeedRandom,
): ExternalMessagePlan {
  const issue = random.int(40, 260);
  const headline = random.pick([
    "Why dispatchers still love whiteboards",
    "Five metrics every fleet manager should track",
    "The quiet cost of empty miles",
    "What we learned from 300 support teams",
    "Design tokens in practice",
    "Closing the books faster without new software",
  ]);
  return {
    entity,
    senderIndex: 0,
    subject: `${entity.name} #${String(issue)}: ${headline}`,
    text: `${entity.name} — issue ${String(issue)}\n\n${headline}\n\nThis week: three short reads, one long one, and a chart we can't stop thinking about.\n\nYou are receiving this because you subscribed with your work address. Unsubscribe any time.`,
    html: `<h1>${entity.name}</h1><h2>${headline}</h2><p>This week: three short reads, one long one, and a chart we can't stop thinking about.</p><p style="font-size:12px;color:#666">Unsubscribe any time.</p>`,
    attachments: [],
    headers: {
      "List-Unsubscribe": `<https://${entity.domain}/unsubscribe?issue=${String(issue)}>`,
      "List-Id": `${entity.name} <news.${entity.domain}>`,
      Precedence: "bulk",
    },
  };
}

export function promotion(entity: ExternalOrg, random: SeedRandom): ExternalMessagePlan {
  const offer = random.pick([
    "20% off everything this weekend",
    "Free shipping ends tonight",
    "New arrivals you'll love",
    "Members-only early access",
  ]);
  return {
    entity,
    senderIndex: 0,
    subject: offer,
    text: `${offer}.\n\nShop the collection at ${entity.domain}. Offer valid while supplies last.`,
    html: `<p style="font-size:20px"><strong>${offer}</strong></p><p>Shop the collection online. Offer valid while supplies last.</p>`,
    attachments: [],
    headers: { "List-Unsubscribe": `<mailto:unsubscribe@${entity.domain}>`, Precedence: "bulk" },
  };
}

export function receipt(
  entity: ExternalOrg,
  person: Person,
  when: Date,
  random: SeedRandom,
): ExternalMessagePlan {
  const amount = money(random.int(18, 980) + random.int(0, 99) / 100);
  const reference = `${entity.key.slice(0, 3).toUpperCase()}-${String(random.int(100000, 999999))}`;
  const lines = [
    `Billed to: ${person.displayName}`,
    `Reference: ${reference}`,
    `Date: ${when.toISOString().slice(0, 10)}`,
    `Total: ${amount}`,
  ];
  return {
    entity,
    senderIndex: 0,
    subject: `Your ${entity.name} receipt ${reference}`,
    text: `Hi ${person.givenName},\n\nThanks for your purchase. Your receipt is attached.\n\n${lines.join("\n")}\n\n${entity.name}`,
    attachments: [
      {
        filename: `receipt-${reference}.pdf`,
        contentType: "application/pdf",
        content: simplePdf(`${entity.name} receipt`, lines),
      },
    ],
  };
}

export function vendorInvoice(
  entity: ExternalOrg,
  when: Date,
  random: SeedRandom,
): ExternalMessagePlan {
  const number = `INV-${String(random.int(20000, 89999))}`;
  const items = Array.from({ length: random.int(2, 5) }, (_, index) => [
    `Line ${String(index + 1)}`,
    random.int(1, 40),
    (random.int(900, 48000) / 100).toFixed(2),
  ]);
  return {
    entity,
    senderIndex: 0,
    subject: `Invoice ${number} from ${entity.name}`,
    text: `Hello ${COMPANY.name} accounts payable,\n\nPlease find invoice ${number} for ${monthName(when)} attached. Payment is due within 30 days.\n\nThank you,\n${entity.name}`,
    attachments: [
      {
        filename: `${number}.pdf`,
        contentType: "application/pdf",
        content: simplePdf(`Invoice ${number}`, [
          entity.name,
          `Period: ${monthName(when)}`,
          ...items.map((item) => item.join(" · ")),
        ]),
      },
      {
        filename: `${number}-lines.csv`,
        contentType: "text/csv",
        content: csv([["item", "quantity", "amount_usd"], ...items]),
      },
    ],
  };
}

export function customerQuestion(entity: ExternalOrg, random: SeedRandom): ExternalMessagePlan {
  const feature = random.pick(FEATURES);
  return {
    entity,
    senderIndex: random.int(0, 3),
    subject: random.pick([
      `Question about ${feature}`,
      "Routes not updating since this morning",
      "Adding two new depots next month",
      `Can we export ${feature} data?`,
      "Invoice address change",
    ]),
    text: `Hi team,\n\nWe've been using ${COMPANY.product} across our depots and ran into a question about ${feature}. Could someone get back to us this week?\n\nThanks,\n${externalAddress(entity, 0).name}\n${entity.name}`,
    attachments: [],
  };
}

export function invitation(
  entity: ExternalOrg,
  organizer: MimeAddress,
  attendee: Person,
  start: Date,
  uid: string,
): ExternalMessagePlan {
  const stamp = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(/\.\d{3}/u, "");
  const end = new Date(start.getTime() + 45 * TIME.MINUTE);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${entity.name}//Scheduling//EN`,
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date(start.getTime() - 5 * TIME.DAY))}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${entity.name} / ${COMPANY.name} sync`,
    `ORGANIZER;CN=${organizer.name}:mailto:${organizer.address}`,
    `ATTENDEE;CN=${attendee.displayName};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${companyAddress(attendee)}`,
    `LOCATION:https://${entity.domain}/meet/${uid.slice(0, 8)}`,
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return {
    entity,
    senderIndex: 0,
    subject: `Invitation: ${entity.name} / ${COMPANY.name} sync @ ${start.toUTCString().slice(0, 22)}`,
    text: `${organizer.name} invited you to a meeting.\n\nWhen: ${start.toUTCString()}\nJoin: https://${entity.domain}/meet/${uid.slice(0, 8)}`,
    attachments: [],
    icalEvent: { method: "REQUEST", content: ics },
  };
}

export function shippingNotice(
  entity: ExternalOrg,
  person: Person,
  random: SeedRandom,
): ExternalMessagePlan {
  const tracking = `PP${String(random.int(100000000, 999999999))}`;
  return {
    entity,
    senderIndex: 0,
    subject: random.pick([
      `Your parcel ${tracking} is out for delivery`,
      `Shipment ${tracking} has been delivered`,
    ]),
    text: `Hi ${person.givenName},\n\nTracking number ${tracking}. Track it any time on our website.\n\n${entity.name}`,
    attachments: [],
  };
}

export function spamMessage(entity: ExternalOrg, random: SeedRandom): ExternalMessagePlan {
  return {
    entity,
    senderIndex: 0,
    subject: random.pick([
      "You have been selected for an exclusive reward",
      "Final notice: claim your gift card",
      "10,000 verified leads for your sales team",
    ]),
    text: "Act now! This exclusive offer expires in 24 hours. Click the link to claim before it is gone.",
    attachments: [],
  };
}

export function securityNotice(entity: ExternalOrg, person: Person): ExternalMessagePlan {
  return {
    entity,
    senderIndex: 0,
    subject: `New sign-in to your ${entity.name} account`,
    text: `Hi ${person.givenName},\n\nWe noticed a new sign-in to your ${entity.name} account from a new browser. If this was you, no action is needed.`,
    attachments: [],
  };
}

export function announcement(
  author: Person,
  when: Date,
  random: SeedRandom,
): { subject: string; text: string } {
  const campaign = random.pick(CAMPAIGNS);
  return random.pick([
    {
      subject: `All-hands recap — ${monthName(when)}`,
      text: `Hi everyone,\n\nThanks for a great all-hands. Recap:\n- Revenue grew again this quarter; details in the Company drive.\n- ${campaign} kicks off next month.\n- Office closed on the next company holiday.\n\nQuestions welcome in #general.${signature(author)}`,
    },
    {
      subject: `Welcome our new teammates`,
      text: `Please join me in welcoming the people who started this week. Say hello in #general and invite them to lunch!${signature(author)}`,
    },
    {
      subject: `Office update: ${monthName(when)}`,
      text: `A few updates from the office: new desks arrive on Tuesday, and the kitchen will be closed Friday afternoon for maintenance.${signature(author)}`,
    },
  ]);
}

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
