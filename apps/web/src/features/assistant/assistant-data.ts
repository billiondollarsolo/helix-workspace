/* Seed data + view types for the Helix AI assistant surface.
   Ported from the design handoff prototype (`app-assistant.jsx`). The thread
   list, quick prompts, and the opening conversation are local seeds; live
   replies come from the real assistant endpoint via `streamAssistantChat`. */

import type { IconName } from "@/components/icons";

/** A conversation entry in the 240px thread list. */
export interface AssistantThread {
  readonly id: string;
  readonly title: string;
  /** Relative time label, e.g. "10m ago". */
  readonly time: string;
  readonly pinned?: boolean;
}

/** A quick-prompt card shown on the empty/new state. */
export interface AssistantQuickPrompt {
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
  /** Tile tint — a hex colour from the handoff palette. */
  readonly color: string;
}

/** A rich block attached to an assistant message. */
export type AssistantBlock =
  | { readonly kind: "list"; readonly title: string; readonly items: readonly string[] }
  | { readonly kind: "draft"; readonly title: string; readonly body: string }
  | { readonly kind: "actions"; readonly items: readonly AssistantActionItem[] };

/** A single navigable action button inside an `actions` block. */
export interface AssistantActionItem {
  readonly label: string;
  readonly icon: IconName;
  /** Surface route segment to navigate to, e.g. "mail" or "docs". */
  readonly target?: string;
}

/** A rendered chat message in the assistant conversation. */
export interface AssistantChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly time: string;
  readonly blocks?: readonly AssistantBlock[];
  /** True while the assistant reply is still streaming in. */
  readonly streaming?: boolean;
  /** True when the reply failed and shows the fallback message. */
  readonly errored?: boolean;
}

export const ASSISTANT_THREADS: readonly AssistantThread[] = [
  { id: "th1", title: "Summarize unread inbox", time: "10m ago" },
  { id: "th2", title: "Draft Q3 board update narrative", time: "1h ago", pinned: true },
  { id: "th3", title: "Find time with Mira this week", time: "3h ago" },
  { id: "th4", title: "Compare Atlas and Northwind contracts", time: "Yesterday" },
  { id: "th5", title: "Brainstorm onboarding hooks", time: "Yesterday" },
  { id: "th6", title: "Help me prep 1:1 with Jonas", time: "2 days ago" },
];

export const ASSISTANT_QUICK_PROMPTS: readonly AssistantQuickPrompt[] = [
  {
    icon: "Mail",
    title: "Catch me up on mail",
    sub: "Summarize unread threads",
    color: "#dc2626",
  },
  {
    icon: "Calendar",
    title: "What's on today?",
    sub: "Agenda + prep notes",
    color: "#ea580c",
  },
  { icon: "Doc", title: "Improve this doc", sub: "Tighten the Q3 roadmap", color: "#2563eb" },
  {
    icon: "Sheet",
    title: "Analyze last quarter",
    sub: "Pull insights from Sheets",
    color: "#059669",
  },
  {
    icon: "Users",
    title: "Who should I talk to?",
    sub: "Find experts on a topic",
    color: "#7c3aed",
  },
  {
    icon: "Sparkles",
    title: "Draft something new",
    sub: "Email · doc · slide · post",
    color: "#db2777",
  },
];

/** The opening seeded conversation shown when a pinned/recent thread is open. */
export const ASSISTANT_SEED_CONVERSATION: readonly AssistantChatMessage[] = [
  {
    id: "seed-1",
    role: "user",
    text: "What's the most important thing I missed while I was off yesterday?",
    time: "10:31 AM",
  },
  {
    id: "seed-2",
    role: "assistant",
    text: "Three things I'd flag from your inbox and calendar yesterday:",
    time: "10:31 AM",
    blocks: [
      {
        kind: "list",
        title: "Atlas renewal — early sign",
        items: [
          "Caroline Reyes (Atlas VP Ops) emailed Rumi about locking in 2027 pricing.",
          "Rumi forwarded it to you at 4:12 PM with a question: should we counter at a higher floor?",
          "Atlas is a $420K ARR account. The renewal isn't due until September, so there's leverage if you want to use it.",
        ],
      },
      {
        kind: "list",
        title: "Auth incident postmortem",
        items: [
          "Daniel published the 05/15 postmortem. Root cause was a stale TLS cert in the staging mesh that propagated to prod.",
          "Action items are owned and dated; no decisions needed from you.",
        ],
      },
      {
        kind: "list",
        title: "Q3 roadmap",
        items: [
          "Mira added a new open decision to the doc: do we hold the new pricing tier or revise. She wants async input by Friday.",
          "Priya commented asking whether to list customers inline or in a linked sheet.",
        ],
      },
      {
        kind: "actions",
        items: [
          { label: "Open Atlas thread", icon: "Mail", target: "mail" },
          { label: "Open postmortem doc", icon: "Doc", target: "docs" },
          { label: "Open Q3 Roadmap", icon: "Doc", target: "docs" },
        ],
      },
    ],
  },
  {
    id: "seed-3",
    role: "user",
    text: "Draft a reply to Rumi suggesting we hold the line on pricing.",
    time: "10:34 AM",
  },
  {
    id: "seed-4",
    role: "assistant",
    text: "Here's a draft. I kept it brief and gave Rumi clear language to take back to Caroline:",
    time: "10:34 AM",
    blocks: [
      {
        kind: "draft",
        title: "Re: Atlas Holdings — they want to renew early",
        body: "Hi Rumi,\n\nLet's hold the current pricing floor for now. Atlas is a strategic account and locking them in early is valuable, but the floor matters more than the timing — every renewal we discount sets a precedent the rest of the book expects.\n\nA few things you can lean on with Caroline:\n\n• We're already at their pricing tier ceiling — they're getting good value.\n• If they want certainty, we can offer a 24-month commit at current rate (not a discount).\n• If they push, escalate to me — I'd rather take the call than concede on day one.\n\nLet me know how she responds.\n\nAlex",
      },
      {
        kind: "actions",
        items: [
          { label: "Send as draft", icon: "Send" },
          { label: "Open in Mail to edit", icon: "Mail" },
          { label: "Regenerate", icon: "Sparkles" },
        ],
      },
    ],
  },
];

/** Model options for the inline composer select. */
export interface AssistantModelOption {
  readonly value: string;
  readonly label: string;
}

export const ASSISTANT_MODELS: readonly AssistantModelOption[] = [
  { value: "helix-pro", label: "Helix Pro" },
  { value: "helix-fast", label: "Helix Fast" },
  { value: "helix-reason", label: "Helix Reason" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "claude-sonnet", label: "Claude Sonnet 4.5" },
  { value: "gemini", label: "Gemini 2.5 Pro" },
];

/** Friendly fallback shown when the assistant endpoint is unreachable. */
export const ASSISTANT_ERROR_FALLBACK =
  "I couldn't reach the model just now. Configure a provider in Settings → Helix AI, or try again in a moment.";

/** Formats the current wall-clock time as a "10:31 AM" label. */
export function assistantNowTime(date: Date = new Date()): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(display)}:${minutes} ${meridiem}`;
}
