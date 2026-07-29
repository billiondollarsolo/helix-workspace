/* Seed data + view types for the Helix AI assistant surface.
   Ported from the design handoff prototype (`app-assistant.jsx`). The thread
   list, quick prompts, and the opening conversation are local seeds; live
   replies come from the real assistant endpoint via `streamAssistantChat`. */

import type { IconName } from "@/components/icons";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";

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

const FULL_WORKSPACE_QUICK_PROMPTS: readonly AssistantQuickPrompt[] = [
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

export function assistantQuickPromptsForBuild(
  storageOnly: boolean,
): readonly AssistantQuickPrompt[] {
  return storageOnly ? STORAGE_ONLY_QUICK_PROMPTS : FULL_WORKSPACE_QUICK_PROMPTS;
}

export const ASSISTANT_QUICK_PROMPTS = assistantQuickPromptsForBuild(CORE_WORKSPACE_STORAGE_ONLY);

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
