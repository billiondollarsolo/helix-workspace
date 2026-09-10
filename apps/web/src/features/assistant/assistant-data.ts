import { type IconName } from "@/components/icon-map";
/* Seed data + view types for the Helix AI assistant surface.
   Ported from the design handoff prototype (`app-assistant.jsx`). The thread
   list, quick prompts, and the opening conversation are local seeds; live
   replies come from the real assistant endpoint via `streamAssistantChat`. */
/** A conversation entry in the 240px thread list. */
export interface AssistantThread {
  readonly id: string;
  readonly title: string;
  /** Relative time label, e.g. "10m ago". */
  readonly time: string;
  /** Last-activity wall-clock for date-bucket grouping (0 when unknown). */
  readonly updatedAtMs: number;
  readonly pinned?: boolean;
}
/** A quick-prompt card shown on the empty/new state. */
interface AssistantQuickPrompt {
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
  /** Tile tint — a hex colour from the handoff palette. */
  readonly color: string;
}
/** A rich block attached to an assistant message. */
export type AssistantBlock =
  | {
      readonly kind: "list";
      readonly title: string;
      readonly items: readonly string[];
    }
  | {
      readonly kind: "draft";
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly kind: "actions";
      readonly items: readonly AssistantActionItem[];
    };
/** A single navigable action button inside an `actions` block. */
interface AssistantActionItem {
  readonly label: string;
  readonly icon: IconName;
  /** Surface route segment to navigate to, e.g. "mail" or "drive". */
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
const STORAGE_ONLY_QUICK_PROMPTS: readonly AssistantQuickPrompt[] = [
  {
    icon: "Mail",
    title: "Catch me up on mail",
    sub: "Summarize unread threads",
    color: "#dc2626",
  },
  {
    icon: "Drive",
    title: "Find a file",
    sub: "Search Drive by name or topic",
    color: "#7c3aed",
  },
  {
    icon: "Chat",
    title: "Catch me up on chat",
    sub: "Summarize relevant conversations",
    color: "#db2777",
  },
  {
    icon: "Sparkles",
    title: "Draft an email",
    sub: "Turn a request into a clear message",
    color: "#2563eb",
  },
];
export const ASSISTANT_QUICK_PROMPTS = STORAGE_ONLY_QUICK_PROMPTS;
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
