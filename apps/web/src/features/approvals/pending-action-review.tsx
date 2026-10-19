import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { SurfaceFrame } from "@/components/shell/surface-frame";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { decidePendingAction, pendingActionReviewQueryOptions } from "./api";

export function PendingActionReview({ pendingId }: { readonly pendingId: string }) {
  const client = useQueryClient();
  const queryKey = pendingActionReviewQueryOptions(pendingId).queryKey;
  const query = useQuery(pendingActionReviewQueryOptions(pendingId));
  const [decision, setDecision] = useState<"approved" | "cancelled" | null>(null);
  const mutation = useMutation({
    mutationFn: (choice: "approve" | "cancel") => decidePendingAction(pendingId, choice),
    onMutate: () => undefined,
    onSuccess: (_result, choice) => {
      setDecision(choice === "approve" ? "approved" : "cancelled");
      void client.invalidateQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ["pending-actions"] });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ["pending-actions"] });
    },
  });
  const data = query.data;
  const email = data !== undefined && !("kind" in data.review) ? data.review : undefined;
  const action = data !== undefined && "kind" in data.review ? data.review : undefined;
  const title = action ? "Review action" : "Review email";
  const pending =
    !query.isError &&
    data?.action.status === "pending_confirmation" &&
    Date.parse(data.action.expiresAt) > query.dataUpdatedAt &&
    decision === null;

  return (
    <SurfaceFrame title={title} icon={<MailCheck aria-hidden="true" />}>
      <section className="min-w-0 flex-1 overflow-y-auto p-5" aria-labelledby="email-review-title">
        <div className="mx-auto grid w-full max-w-3xl gap-4">
          <header>
            <h1 id="email-review-title" className="type-h1">
              {title}
            </h1>
            <p className="type-body-sm text-muted-foreground">
              {action
                ? "An agent requested this action. Review its arguments, targets and consequences before deciding."
                : "An agent requested this send. Read the recipients and message before deciding."}
            </p>
          </header>
          {query.isPending ? (
            <Skeleton variant="text" count={4} label="Loading email request" />
          ) : null}
          {query.isError ? (
            <InlineError
              title="Couldn’t load the email request"
              message={query.error.message}
              onRetry={() => {
                void client.invalidateQueries({ queryKey });
              }}
              retrying={query.isFetching}
            />
          ) : null}
          {data ? (
            <>
              {email ? (
                <>
                  <dl className="grid min-w-0 gap-2 rounded-lg border border-border bg-card p-4 type-body-sm">
                    {[
                      ["From", email.from?.address ?? "Requesting agent’s mailbox"],
                      ["To", email.to.map((address) => address.address).join(", ")],
                      ["Cc", email.cc.map((address) => address.address).join(", ")],
                      ["Bcc", email.bcc.map((address) => address.address).join(", ")],
                      ["Reply to", email.replyTo?.address],
                      ["Subject", email.subject || "(no subject)"],
                    ]
                      .filter(([, value]) => Boolean(value))
                      .map(([label, value]) => (
                        <div key={label} className="grid min-w-0 gap-1 sm:grid-cols-[5rem_1fr]">
                          <dt className="font-semibold">{label}</dt>
                          <dd className="m-0 break-words">{value}</dd>
                        </div>
                      ))}
                  </dl>
                  <section
                    aria-label="Email message"
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <p className="m-0 whitespace-pre-wrap break-words type-body">
                      {email.bodyText}
                    </p>
                    {email.bodyHtml !== undefined ? (
                      <details className="mt-3">
                        <summary>HTML source</summary>
                        <pre className="overflow-auto whitespace-pre-wrap break-words type-meta">
                          {email.bodyHtml}
                        </pre>
                      </details>
                    ) : null}
                  </section>
                  {email.attachments.length > 0 ? (
                    <section aria-label="Attachments">
                      <h2 className="type-h3">Attachments</h2>
                      <ul>
                        {email.attachments.map((file) => (
                          <li key={file.objectId} className="break-words">
                            {file.filename ?? file.objectId}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : null}
              {action ? (
                <>
                  <p className="type-body-sm">{action.preview.consequence}</p>
                  <dl className="grid gap-2 type-body-sm">
                    {[
                      ["Tool", action.preview.toolId],
                      ["Permission", action.preview.action],
                      ["Resources", action.preview.resourceIds.join(", ")],
                      ["Recipients", action.preview.recipients.join(", ")],
                      ["Targets", action.preview.targets.join(", ")],
                      ["Sources", action.sourceIds.join(", ") || "Unknown external agent context"],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="font-semibold">{label}</dt>
                        <dd className="m-0 break-words">{value || "None"}</dd>
                      </div>
                    ))}
                  </dl>
                  <section aria-label="Proposed arguments">
                    <h2 className="type-h3">Proposed arguments</h2>
                    <p className="type-meta text-muted-foreground">
                      Credential fields are redacted. Approval executes the original stored
                      arguments once.
                    </p>
                    <pre className="overflow-auto whitespace-pre-wrap break-words type-meta">
                      {JSON.stringify(action.input, null, 2)}
                    </pre>
                  </section>
                </>
              ) : null}
              <p className="type-meta text-muted-foreground">
                Approval expires{" "}
                <time dateTime={data.action.expiresAt}>
                  {new Date(data.action.expiresAt).toLocaleString()}
                </time>
                .
                {email?.sendAt ? (
                  <>
                    {" "}
                    Scheduled for{" "}
                    <time dateTime={email?.sendAt}>{new Date(email?.sendAt).toLocaleString()}</time>
                    .
                  </>
                ) : null}
              </p>
              <p role="status" className="type-body-sm">
                {decision === "approved" || data.action.status === "executed"
                  ? action
                    ? "Approved. Helix executed the action."
                    : "Approved. Helix accepted the send request."
                  : decision === "cancelled" || data.action.status === "cancelled"
                    ? action
                      ? "Denied. This action will not run."
                      : "Denied. This email will not be sent."
                    : pending
                      ? action
                        ? "This action has not run."
                        : "This email has not been sent."
                      : `This request is ${data.action.status === "pending_confirmation" ? "expired" : data.action.status}.`}
              </p>
              {mutation.isError ? (
                <InlineError
                  title="Couldn’t apply your decision"
                  message={mutation.error.message}
                  variant="compact"
                />
              ) : null}
              {pending ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => mutation.mutate("cancel")}
                    disabled={mutation.isPending}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    onClick={() => mutation.mutate("approve")}
                    disabled={mutation.isPending}
                    aria-busy={mutation.isPending}
                  >
                    {mutation.isPending
                      ? "Applying decision…"
                      : action
                        ? "Approve and run"
                        : "Approve and send"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </SurfaceFrame>
  );
}
