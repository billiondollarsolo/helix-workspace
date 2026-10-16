import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { MailRuleProposal } from "@helix/contracts";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { SettingsField } from "@/components/shell/settings-controls";
import { callTool } from "@/lib/tool-call";
import { FilterDialog } from "../settings/filter-dialog";
import { filterDraftFromRecord } from "../settings/filter-model";

export function RuleProposal() {
  const [instructions, setInstructions] = useState("");
  const [proposal, setProposal] = useState<MailRuleProposal | null>(null);
  const [editing, setEditing] = useState(false);
  const generate = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => callTool<MailRuleProposal>("mail.filter.propose", { instructions }),
    onSuccess: setProposal,
  });
  const preview = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () =>
      callTool<{
        matches: { threadId: string; messageId: string; subject: string }[];
        sampledThreads: number;
        truncated: boolean;
      }>("mail.filter.preview", { criteria: proposal?.criteria }),
  });
  return (
    <section className="admin-stack" aria-label="Draft a mail rule">
      <SettingsField
        label="Describe your rule"
        controlId="mail-rule-instructions"
        hint="For example: star messages from accounts@example.com whose subject contains invoice."
      >
        <Textarea
          id="mail-rule-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={2000}
        />
      </SettingsField>
      <Button
        disabled={!instructions.trim() || generate.isPending}
        onClick={() => {
          setProposal(null);
          preview.reset();
          generate.mutate();
        }}
      >
        Draft rule
      </Button>
      {generate.error ? (
        <p role="alert" className="text-destructive">
          {generate.error.message}
        </p>
      ) : null}
      {proposal ? (
        <>
          <SettingsField label="Rule name" controlId="mail-rule-name">
            <Input
              id="mail-rule-name"
              value={proposal.name}
              onChange={(event) => setProposal({ ...proposal, name: event.target.value })}
            />
          </SettingsField>
          <p className="type-body-sm">
            Matches:{" "}
            {Object.entries(proposal.criteria)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join("; ")}
          </p>
          <p className="type-body-sm">
            Actions:{" "}
            {Object.entries(proposal.actions)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join("; ")}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending}>
              Preview matches
            </Button>
            <Button onClick={() => setEditing(true)}>Review and edit rule</Button>
          </div>
          <p className="type-caption">Nothing is enabled until you save in the rule editor.</p>
        </>
      ) : null}
      {preview.error ? (
        <p role="alert" className="text-destructive">
          {preview.error.message}
        </p>
      ) : null}
      {preview.data ? (
        <div>
          <p>
            Sampled {preview.data.sampledThreads} conversations.{" "}
            {preview.data.truncated
              ? "This is a limited sample, not the full mailbox."
              : "Sample complete."}
          </p>
          <ul>
            {preview.data.matches.map((item) => (
              <li key={item.messageId}>
                <a href={`/mail?thread=${item.threadId}`}>{item.subject || "(no subject)"}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {editing && proposal ? (
        <FilterDialog
          onClose={() => setEditing(false)}
          initialDraft={filterDraftFromRecord({
            id: "",
            name: proposal.name,
            enabled: true,
            priority: 100,
            criteria: proposal.criteria,
            actions: proposal.actions,
            createdAt: "",
            updatedAt: "",
          })}
          prefill={{}}
        />
      ) : null}
    </section>
  );
}
