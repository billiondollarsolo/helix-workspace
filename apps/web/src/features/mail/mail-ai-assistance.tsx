import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { MailAiSuggestionInput, MailAiSuggestionResult } from "@helix/contracts";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormPanel } from "@/components/ui/form-panel";
import { Input, Textarea } from "@/components/ui/input";
import { InlineError } from "@/components/ui/inline-error";
import { callTool } from "@/lib/tool-call";

function mailAiStatusQueryOptions() {
  return queryOptions({
    queryKey: ["mail", "ai", "status"],
    queryFn: () => callTool<{ enabled: boolean }>("mail.ai.status", {}),
    staleTime: 30000,
  });
}

export function MailAiAssistance({
  threadId,
  subject = "",
  body = "",
  onApply,
}: {
  readonly threadId?: string | undefined;
  readonly subject?: string;
  readonly body?: string;
  readonly onApply?: (text: string) => void;
}) {
  const status = useQuery(mailAiStatusQueryOptions());
  const [open, setOpen] = useState(false);
  if (status.data?.enabled !== true) return null;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden="true" />
        {onApply === undefined ? "Summarize" : "Help me write"}
      </Button>
      {open ? (
        <MailAiPanel
          threadId={threadId}
          subject={subject}
          body={body}
          onApply={onApply}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MailAiPanel({
  threadId,
  subject,
  body,
  onApply,
  onClose,
}: {
  readonly threadId: string | undefined;
  readonly subject: string;
  readonly body: string;
  readonly onApply: ((text: string) => void) | undefined;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [instructions, setInstructions] = useState("");
  const [action, setAction] = useState<MailAiSuggestionInput["action"]>(
    onApply === undefined ? "summarize" : threadId === undefined ? "compose" : "reply",
  );
  const [result, setResult] = useState<{ text: string; body: string; subject: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const changed = result !== null && (result.body !== body || result.subject !== subject);
  async function generate() {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const suggestion = await callTool<MailAiSuggestionResult>(
        "mail.ai.suggest",
        {
          action,
          subject,
          body,
          instructions,
          ...(threadId === undefined ? {} : { threadId }),
        },
        { signal: request.signal, autoApprove: false },
      );
      if (!request.signal.aborted) setResult({ text: suggestion.text, body, subject });
    } catch (failure) {
      if (!request.signal.aborted)
        setError(failure instanceof Error ? failure.message : "Could not generate a suggestion.");
    } finally {
      if (controller.current === request) setBusy(false);
    }
  }
  return (
    <FormPanel
      title={onApply === undefined ? "Conversation summary" : "Help me write"}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                controller.current?.abort();
                setBusy(false);
              }}
            >
              Cancel generation
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                void generate();
              }}
            >
              Generate
            </Button>
          )}
          {onApply !== undefined && result !== null ? (
            <Button
              type="button"
              disabled={changed || busy || !result.text.trim()}
              onClick={() => {
                onApply(result.text);
                onClose();
              }}
            >
              Use in draft
            </Button>
          ) : null}
        </>
      }
    >
      <div className="admin-stack">
        <p className="text-sm text-muted-foreground">
          AI can make mistakes. Review names, facts, and commitments. Nothing is sent automatically.
        </p>
        {onApply === undefined ? null : (
          <div role="group" aria-label="Writing task" className="flex flex-wrap gap-2">
            {(["compose", "rewrite", ...(threadId === undefined ? [] : ["reply"])] as const).map(
              (value) => (
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  aria-pressed={action === value}
                  onClick={() => setAction(value as MailAiSuggestionInput["action"])}
                >
                  {value === "compose" ? "Draft" : value === "rewrite" ? "Rewrite" : "Reply"}
                </Button>
              ),
            )}
          </div>
        )}
        <label htmlFor={`${id}-instructions`}>Writing instructions (optional)</label>
        <Input
          id={`${id}-instructions`}
          value={instructions}
          maxLength={2000}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="For example: keep it brief and friendly"
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          Uses your draft and the selected conversation. Attachments are not included.
        </p>
        {busy ? <p role="status">Generating…</p> : null}
        {error === null ? null : (
          <InlineError variant="compact" title="Couldn't generate text" message={error} />
        )}
        {changed ? (
          <p role="status">Your draft changed. Generate again to keep your latest edits.</p>
        ) : null}
        {result === null ? null : (
          <>
            <label htmlFor={`${id}-result`}>
              {onApply === undefined ? "Summary" : "Suggested text"}
            </label>
            <Textarea
              id={`${id}-result`}
              value={result.text}
              rows={12}
              maxLength={24000}
              readOnly={onApply === undefined}
              onChange={(event) => setResult({ ...result, text: event.target.value })}
            />
          </>
        )}
      </div>
    </FormPanel>
  );
}
