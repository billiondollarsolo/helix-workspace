import { queryOptions } from "@tanstack/react-query";
import { callTool } from "@/lib/tool-call";
import type { BotAccountRequest, MailThreadRow } from "@helix/contracts";
export interface Bot {
  id: string;
  displayName: string;
  email: string | null;
  disabled: boolean;
}
export interface WorkspaceData {
  threads?: MailThreadRow[];
  total?: number;
  thread?: {
    subject: string;
    messages: {
      id: string;
      from?: { name?: string; address: string };
      plainBody?: string;
      body: string;
      sentAt: string;
    }[];
    nextCursor?: string;
  };
  entries?: { id: string; type: string; name: string; byteSize?: number; available?: boolean }[];
  nextCursor?: string | null;
  rooms?: { id: string; subject: string | null; kind: string }[];
  messages?: { id: string; body: string; sentAt: string }[];
  activity?: { id: string; verb: string; created_at: string }[];
}

export const botRequestsQueryOptions = () =>
  queryOptions({
    queryKey: ["bots", "requests"],
    queryFn: () => callTool<{ requests: BotAccountRequest[] }>("agent.account.requests.list", {}),
    refetchInterval: 15000,
  });
export const botsQueryOptions = () =>
  queryOptions({
    queryKey: ["bots", "visible"],
    queryFn: () => callTool<{ bots: Bot[] }>("agent.workspace.list", {}),
    refetchInterval: 30000,
  });
export const botWorkspaceQueryOptions = (input: {
  botActorId: string;
  surface: "mail" | "files" | "chat" | "activity";
  offset: number;
  threadId?: string;
  roomId?: string;
  cursor?: string;
}) =>
  queryOptions({
    queryKey: ["bots", "workspace", input],
    queryFn: () => callTool<WorkspaceData>("agent.workspace.read", input),
    refetchInterval: 30000,
  });
