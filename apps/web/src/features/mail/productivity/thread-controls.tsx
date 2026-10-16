import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FormPanel } from "@/components/ui/form-panel";
import { callTool } from "@/lib/tool-call";
import type { MailProductivityArtifact } from "@helix/contracts";
import {
  prepareProductivityArtifact,
  productivityArtifactsQueryOptions,
  productivitySettingsQueryOptions,
} from "./api";

export function FollowUpControl({
  threadId,
  messageId,
}: {
  readonly threadId: string;
  readonly messageId: string;
}) {
  const client = useQueryClient();
  const change = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (state: string) => callTool("mail.followup.set", { threadId, messageId, state }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["mail"] }),
  });
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Conversation follow-up">
      <label className="type-body-sm" htmlFor={`follow-up-${threadId}`}>
        Follow-up
      </label>
      <select
        id={`follow-up-${threadId}`}
        className="input"
        value=""
        disabled={change.isPending}
        onChange={(event) => change.mutate(event.target.value)}
      >
        <option value="" disabled>
          Set status…
        </option>
        <option value="automatic">Automatic</option>
        <option value="needs_reply">Needs reply</option>
        <option value="waiting_on">Waiting on</option>
        <option value="done">Done</option>
      </select>
      {change.error ? (
        <p role="alert" className="text-destructive type-body-sm">
          {change.error.message}
        </p>
      ) : null}
      {change.isSuccess ? (
        <span role="status" className="type-caption">
          Follow-up updated
        </span>
      ) : null}
    </div>
  );
}
export function PreparedReply({
  threadId,
  body,
  onApply,
}: {
  readonly threadId: string;
  readonly body: string;
  readonly onApply: (text: string) => void;
}) {
  const client = useQueryClient();
  const currentBody = useRef(body);
  currentBody.current = body;
  const settings = useQuery(productivitySettingsQueryOptions());
  const artifacts = useQuery({
    ...productivityArtifactsQueryOptions(),
    enabled: settings.data?.aiEnabled === true,
  });
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState(body);
  const prepare = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => prepareProductivityArtifact("mail.reply.prepare", { threadId }),
  });
  const apply = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async (expected: MailProductivityArtifact) => {
      const fresh = await client.fetchQuery({
        ...productivityArtifactsQueryOptions(),
        staleTime: 0,
      });
      const current = fresh.artifacts.find(
        (item) =>
          item.id === expected.id &&
          item.sourceKey === expected.sourceKey &&
          item.status === "ready",
      );
      if (!current || current.text !== expected.text)
        throw new Error(
          "The conversation or suggestion changed. Prepare the latest reply before applying it.",
        );
      if (currentBody.current.trim() || currentBody.current !== baseline)
        throw new Error("Your draft changed. It has been preserved.");
      return current.text;
    },
    onSuccess: (text) => {
      onApply(text);
      setOpen(false);
    },
  });
  const cached = artifacts.data?.artifacts.find(
    (item) => item.kind === "reply" && item.sourceKey.startsWith(`${threadId}:`),
  );
  const result = prepare.data ?? cached;
  if (!settings.data?.aiEnabled) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setBaseline(body);
          setOpen(true);
        }}
      >
        {cached?.status === "ready" ? "Review prepared reply" : "Prepare reply"}
      </Button>
      {open ? (
        <FormPanel
          title="Prepared reply"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => prepare.mutate()}
                disabled={prepare.isPending}
              >
                Prepare latest reply
              </Button>
              <Button
                disabled={
                  result?.status !== "ready" ||
                  body !== baseline ||
                  body.trim().length > 0 ||
                  prepare.isPending ||
                  apply.isPending
                }
                onClick={() => {
                  if (result?.status === "ready") {
                    apply.mutate(result);
                  }
                }}
              >
                Use in empty draft
              </Button>
            </>
          }
        >
          <p className="type-body-sm text-muted-foreground">
            AI suggestion; review its facts and recipients before sending. Your existing draft is
            preserved.
          </p>
          {body.trim() ? (
            <p role="status">
              Your draft already contains text. You can copy selected wording from the suggestion
              below.
            </p>
          ) : null}
          {prepare.error || apply.error ? (
            <p role="alert" className="text-destructive">
              {prepare.error?.message ?? apply.error?.message}
            </p>
          ) : null}
          {result ? (
            <div className="whitespace-pre-wrap type-body-sm">
              {result.status === "ready"
                ? result.text
                : (result.error ?? "Preparation is in progress. Refresh shortly.")}
            </div>
          ) : (
            <p>No prepared suggestion yet.</p>
          )}
        </FormPanel>
      ) : null}
    </>
  );
}
