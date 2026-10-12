const DEMO_SIZES = ["small", "medium", "large"] as const;
export type DemoSize = (typeof DEMO_SIZES)[number];

/** Volume per preset. `small` is what CI seeds; `medium` is the local default. */
export interface DemoPreset {
  readonly headcount: number;
  readonly historyDays: number;
  /** Conversations started per active person over the whole history. */
  readonly mailThreadsPerPerson: number;
  /** External mail (newsletters, receipts, customers) per active person. */
  readonly inboundPerPerson: number;
  readonly driveFilesPerPerson: number;
  readonly chatMessagesPerSpace: number;
  readonly directMessagesPerPair: number;
  readonly oneOffEventsPerPerson: number;
  readonly contactsPerPerson: number;
  readonly pastMeetings: number;
  readonly assistantConversations: number;
  /** Delivery log entries per outbound webhook. */
  readonly webhookDeliveries: number;
}

export const DEMO_PRESETS: Readonly<Record<DemoSize, DemoPreset>> = {
  small: {
    headcount: 60,
    historyDays: 800,
    mailThreadsPerPerson: 3,
    inboundPerPerson: 4,
    driveFilesPerPerson: 2,
    chatMessagesPerSpace: 40,
    directMessagesPerPair: 8,
    oneOffEventsPerPerson: 1,
    contactsPerPerson: 3,
    pastMeetings: 12,
    assistantConversations: 4,
    webhookDeliveries: 4,
  },
  medium: {
    headcount: 80,
    historyDays: 900,
    mailThreadsPerPerson: 5,
    inboundPerPerson: 8,
    driveFilesPerPerson: 4,
    chatMessagesPerSpace: 90,
    directMessagesPerPair: 12,
    oneOffEventsPerPerson: 3,
    contactsPerPerson: 6,
    pastMeetings: 40,
    assistantConversations: 10,
    webhookDeliveries: 20,
  },
  large: {
    headcount: 120,
    historyDays: 1000,
    mailThreadsPerPerson: 28,
    inboundPerPerson: 45,
    driveFilesPerPerson: 16,
    chatMessagesPerSpace: 700,
    directMessagesPerPair: 80,
    oneOffEventsPerPerson: 6,
    contactsPerPerson: 15,
    pastMeetings: 180,
    assistantConversations: 30,
    webhookDeliveries: 80,
  },
};

export function parseDemoSize(value: string): DemoSize {
  if ((DEMO_SIZES as readonly string[]).includes(value)) return value as DemoSize;
  throw new Error(`--size must be one of ${DEMO_SIZES.join(", ")}; got "${value}".`);
}
