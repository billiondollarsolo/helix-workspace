/* Chat seed data — ported verbatim from the design handoff
   (`app-sheets-meet-chat.jsx` — Chat section). Typed module data stands in
   for the backend until the real chat tools (see `api.ts`) are wired: the
   production tools use UUID room ids and a different message shape, so the
   handoff's hand-authored spaces/threads ship as static seed data. */

/** Presence state for a direct-message peer. Drives the sidebar status dot. */
export type ChatPresence = "active" | "away" | "offline";

/** A reaction pill on a message — emoji glyph plus a running count. */
export interface ChatReaction {
  readonly emoji: string;
  readonly count: number;
}

/** A top-level message in a channel. `who` is `"you"` for the current user. */
export interface ChatMessage {
  readonly id: string;
  readonly who: string;
  readonly time: string;
  readonly msgs: readonly string[];
  readonly replies?: number;
  readonly reactions?: readonly ChatReaction[];
  readonly pinned?: boolean;
}

/** A reply inside a thread, keyed by its parent message id. */
export interface ChatThreadReply {
  readonly who: string;
  readonly time: string;
  readonly msg: string;
}

/** A space (channel) in the Spaces sidebar section. */
export interface ChatSpace {
  readonly id: string;
  readonly name: string;
  readonly unread: number;
}

/** A direct-message peer in the Direct messages sidebar section. */
export interface ChatDirectMessage {
  readonly id: string;
  readonly name: string;
  readonly presence: ChatPresence;
  readonly unread?: number;
}

/** A file shared into a space — shown in the info panel's Files tab. */
export interface ChatSharedFile {
  readonly name: string;
  readonly who: string;
  readonly time: string;
  readonly kind: "doc" | "pdf" | "sheet";
}

export const CHAT_SPACES: readonly ChatSpace[] = [
  { id: "platform", name: "Platform Engineering", unread: 3 },
  { id: "design", name: "Design Crit", unread: 0 },
  { id: "all", name: "All Helix", unread: 12 },
  { id: "sales", name: "Sales War Room", unread: 0 },
  { id: "random", name: "watercooler", unread: 0 },
];

export const CHAT_DIRECT_MESSAGES: readonly ChatDirectMessage[] = [
  { id: "mira", name: "Mira Okafor", presence: "active", unread: 1 },
  { id: "jonas", name: "Jonas Reichert", presence: "active" },
  { id: "priya", name: "Priya Anand", presence: "away" },
  { id: "daniel", name: "Daniel Cho", presence: "active" },
  { id: "sasha", name: "Sasha Levin", presence: "offline" },
];

/** Channel messages keyed by space id. */
export const CHAT_MESSAGES: Readonly<Record<string, readonly ChatMessage[]>> = {
  platform: [
    {
      id: "p1",
      who: "Daniel Cho",
      time: "9:14 AM",
      msgs: [
        "I'm rolling the v2.4 platform release to canary in ~30 min.",
        "Once it bakes for an hour I'll promote to 25% prod.",
      ],
      replies: 4,
    },
    {
      id: "p2",
      who: "Jonas Reichert",
      time: "9:18 AM",
      msgs: [
        "Cool — let me know when 25% lands, I want to keep an eye on the latency dash.",
      ],
    },
    {
      id: "p3",
      who: "Lin Wei",
      time: "9:42 AM",
      msgs: [
        "Question — are we still on track for the cert rotation tomorrow? I want to make sure I'm around.",
      ],
    },
    {
      id: "p4",
      who: "Daniel Cho",
      time: "9:43 AM",
      msgs: ["Yes, 8 AM PT. I'll send a calendar block."],
      reactions: [
        { emoji: "👍", count: 3 },
        { emoji: "🙏", count: 1 },
      ],
    },
    {
      id: "p5",
      who: "Jonas Reichert",
      time: "10:21 AM",
      msgs: [
        "FYI — Mira asked if we can also include the rate-limit work in this release notes. I said yes since it's already in.",
      ],
      pinned: true,
      replies: 2,
    },
    {
      id: "p6",
      who: "Daniel Cho",
      time: "10:25 AM",
      msgs: ["On it. Updating release notes now."],
    },
    {
      id: "p7",
      who: "you",
      time: "10:42 AM",
      msgs: ["Thanks team — let me know if the canary needs eyes."],
    },
  ],
};

/** Thread replies keyed by parent message id. */
export const CHAT_THREAD_REPLIES: Readonly<Record<string, readonly ChatThreadReply[]>> = {
  p1: [
    {
      who: "Jonas Reichert",
      time: "9:16 AM",
      msg: "What's the rollback target if canary breaks?",
    },
    {
      who: "Daniel Cho",
      time: "9:17 AM",
      msg: "v2.3.1, same as last week. Auto-rollback on >0.5% 5xx for >2 min.",
    },
    {
      who: "Lin Wei",
      time: "9:20 AM",
      msg: 'Can we wire the canary status into #all-helix? Saw a few "is anything happening?" messages last release.',
    },
    {
      who: "Daniel Cho",
      time: "9:22 AM",
      msg: "Yeah — I'll add the status webhook. Good call.",
    },
  ],
  p5: [
    {
      who: "Daniel Cho",
      time: "10:23 AM",
      msg: "Done. Section added at the bottom of the notes.",
    },
    {
      who: "Mira Okafor",
      time: "10:24 AM",
      msg: "Thank you both 🙏",
    },
  ],
};

export const CHAT_SHARED_FILES: readonly ChatSharedFile[] = [
  { name: "v2.4-release-notes.md", who: "Daniel Cho", time: "10:25 AM", kind: "doc" },
  { name: "canary-runbook.pdf", who: "Lin Wei", time: "Yesterday", kind: "pdf" },
  { name: "latency-baseline.xlsx", who: "Jonas Reichert", time: "Monday", kind: "sheet" },
];

/** Members shown in the info panel's Members tab. */
export interface ChatMember {
  readonly name: string;
  readonly role: string;
}

export const CHAT_MEMBERS: readonly ChatMember[] = [
  { name: "Jonas Reichert", role: "Staff Engineer" },
  { name: "Daniel Cho", role: "Platform Engineer" },
  { name: "Lin Wei", role: "Site Reliability Engineer" },
  { name: "Mira Okafor", role: "Engineering Manager" },
  { name: "Priya Anand", role: "Product Manager" },
  { name: "Sasha Levin", role: "Infrastructure Engineer" },
  { name: "Alex Park", role: "Platform Engineer" },
  { name: "Noah Bennett", role: "Security Engineer" },
];

/** Per-space "about" metadata for the info panel's About tab. */
export interface ChatSpaceAbout {
  readonly description: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly memberCount: number;
}

export const CHAT_SPACE_ABOUT: Readonly<Record<string, ChatSpaceAbout>> = {
  platform: {
    description:
      "Platform engineering coordination — releases, on-call, incidents, and infra reviews.",
    createdBy: "Jonas Reichert",
    createdAt: "Jan 12, 2025",
    memberCount: 14,
  },
};

export const DEFAULT_CHAT_SPACE_ABOUT: ChatSpaceAbout = {
  description: "A Helix space.",
  createdBy: "Helix",
  createdAt: "2025",
  memberCount: 14,
};

/** The signed-in user — handoff seed assumes "Alex Park". */
export const CHAT_CURRENT_USER = "Alex Park";

/** Resolve a `who` field to a display name (`"you"` → the current user). */
export function chatDisplayName(who: string): string {
  return who === "you" ? CHAT_CURRENT_USER : who;
}
