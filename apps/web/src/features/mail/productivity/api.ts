import { queryOptions } from "@tanstack/react-query";
import { callTool } from "@/lib/tool-call";
import { mailProductivityArtifactSchema } from "@helix/contracts";
import type {
  MailProductivityArtifact,
  MailProductivityPreferences,
  MailThreadRow,
} from "@helix/contracts";
export const productivitySettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["mail", "productivity", "settings"],
    queryFn: () =>
      callTool<{ settings: MailProductivityPreferences; aiEnabled: boolean }>(
        "mail.productivity.settings.get",
        {},
      ),
    staleTime: 30000,
  });
export const productivityArtifactsQueryOptions = () =>
  queryOptions({
    queryKey: ["mail", "productivity", "artifacts"],
    queryFn: () =>
      callTool<{ artifacts: MailProductivityArtifact[] }>("mail.productivity.artifacts.list", {}),
    refetchInterval: 30000,
  });
export interface ActionDigest {
  generatedAt: string;
  needsReply: { threads: MailThreadRow[]; total: number };
  waitingOn: { threads: MailThreadRow[]; total: number };
  meetings: { id: string; title: string; startsAt: string; href: string }[];
  calendarError: string | null;
  approvalsHref: string;
  note: string;
}
export const actionDigestQueryOptions = () =>
  queryOptions({
    queryKey: ["mail", "productivity", "digest"],
    queryFn: () => callTool<ActionDigest>("mail.action.digest", {}),
    refetchInterval: 60000,
  });

export const productivityFoldersQueryOptions = () =>
  queryOptions({
    queryKey: ["drive", "productivity-folders"],
    queryFn: () =>
      callTool<{ entries: { id: string; name: string; type: string }[]; nextCursor?: string }>(
        "drive.list",
        { kind: "folder", acrossFolders: true, limit: 200 },
      ),
  });

export async function prepareProductivityArtifact(
  tool: "mail.reply.prepare" | "mail.meeting.brief",
  input: unknown,
) {
  const result = await callTool<unknown>(tool, input, { autoApprove: false });
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "pending_confirmation"
  ) {
    throw new Error(
      "Preparation is waiting for human review. Open Approvals, then refresh after approval.",
    );
  }
  return mailProductivityArtifactSchema.parse(result);
}
