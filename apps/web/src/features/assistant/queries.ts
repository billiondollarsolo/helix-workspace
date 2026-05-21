import { queryOptions } from "@tanstack/react-query";
import type { AIProvenanceArtifact } from "@/features/ai/provenance";
import type { ToolStatus } from "@/features/assistant/tool-decisions";

export interface AssistantCitation {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly confidence: string;
}

export interface AssistantToolCall {
  readonly id: string;
  readonly pendingId?: string;
  readonly name: string;
  readonly description: string;
  readonly risk: string;
  readonly status: ToolStatus;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly author: string;
  readonly body: string;
  readonly sentAt: string;
  readonly status?: "error";
  /** True while the assistant response is still streaming in. */
  readonly streaming?: boolean;
  readonly citations?: readonly AssistantCitation[];
  readonly toolCalls?: readonly AssistantToolCall[];
  readonly provenance?: AIProvenanceArtifact;
}

export interface AssistantConversation {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly updatedAt: string;
  readonly pinned?: boolean;
  readonly messages: readonly AssistantMessage[];
}

export const assistantQueryKeys = {
  conversations: ["assistant", "conversations"] as const,
};

export function assistantConversationListQueryOptions() {
  return queryOptions({
    queryKey: assistantQueryKeys.conversations,
    queryFn: listInitialAssistantConversations,
    staleTime: 60_000,
  });
}

export function listInitialAssistantConversations(): readonly AssistantConversation[] {
  return initialAssistantConversations;
}

const assistantProvenance: AIProvenanceArtifact = {
  artifactId: "ai-artifact-assistant-phase-8",
  feature: "assistant.conversation",
  providerId: "openai-compatible.local",
  model: "gpt-4.1-mini",
  promptHash: "sha256:8b9f6f8c2d21",
  createdAt: "2026-05-20T04:00:00.000Z",
  actorName: "Local User",
  classification: "standard",
  inputTokens: 1824,
  outputTokens: 476,
  costUsdMicros: 1240,
  latencyMs: 913,
  traceId: "trace-assistant-task-901",
  tools: [
    {
      id: "tool-drive-search",
      name: "drive.search",
      status: "succeeded",
      summary: "Matched source documents for the launch planning context.",
    },
    {
      id: "tool-calendar-read",
      name: "calendar.read",
      status: "skipped",
      summary: "Awaiting confirmation before reading the release calendar.",
    },
  ],
  sources: [
    {
      id: "src-roadmap",
      title: "Roadmap notes",
      type: "drive.object",
      reference: "drive.object/roadmap-notes",
    },
    {
      id: "src-thread",
      title: "Quarterly planning thread",
      type: "mail.thread",
      reference: "mail.thread/planning-q2",
    },
  ],
};

const initialAssistantConversations: readonly AssistantConversation[] = [
  {
    id: "planning",
    title: "Quarterly planning",
    summary: "Summaries, owners, and source trails for release planning.",
    updatedAt: "10:42 AM",
    pinned: true,
    messages: [
      {
        id: "msg-planning-1",
        role: "user",
        author: "You",
        body: "Summarize what changed in quarterly planning and list the sources.",
        sentAt: "10:38 AM",
      },
      {
        id: "msg-planning-2",
        role: "assistant",
        author: "Helix Assistant",
        body: "Quarterly planning shifted toward the Phase 1 platform SDK surfaces, with AI provenance, suggestion-slot UI work, and workspace shell integration now visible in the web app. The next follow-up is confirming whether the release calendar should be read before drafting owner reminders.",
        sentAt: "10:39 AM",
        citations: [
          {
            id: "cite-thread",
            label: "Quarterly planning thread",
            source: "mail.thread/planning-q2",
            confidence: "High",
          },
          {
            id: "cite-roadmap",
            label: "Roadmap notes",
            source: "drive.object/roadmap-notes",
            confidence: "High",
          },
        ],
        toolCalls: [
          {
            id: "tool-calendar",
            pendingId: "00000000-0000-4000-8000-000000000901",
            name: "Read release calendar",
            description:
              "Check the release calendar for owner reminder dates before drafting messages.",
            risk: "Reads calendar metadata only",
            status: "pending",
          },
        ],
        provenance: assistantProvenance,
      },
    ],
  },
  {
    id: "support",
    title: "Support escalation",
    summary: "Customer import delays and suggested response language.",
    updatedAt: "9:21 AM",
    messages: [
      {
        id: "msg-support-1",
        role: "user",
        author: "You",
        body: "Turn the customer import delay notes into a concise status update.",
        sentAt: "9:18 AM",
      },
      {
        id: "msg-support-2",
        role: "assistant",
        author: "Helix Assistant",
        body: "Two workspaces are seeing delayed imports. The status update should say sync is progressing, no data loss has been detected, and support will post the next checkpoint after queue lag drops below the alert threshold.",
        sentAt: "9:19 AM",
        citations: [
          {
            id: "cite-support",
            label: "Customer support room",
            source: "chat.room/customer-support",
            confidence: "Medium",
          },
        ],
        provenance: {
          ...assistantProvenance,
          artifactId: "ai-artifact-assistant-support",
          feature: "assistant.status-draft",
        },
      },
    ],
  },
];
