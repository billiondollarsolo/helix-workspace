import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  mailProductivityPreferencesSchema,
  type MailProductivityPreferences,
} from "@helix/contracts";
import { SettingsField } from "@/components/shell/settings-controls";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { SettingToggle } from "@/features/admin/console/widgets";
import { AdminTable } from "@/features/admin/console/table";
import { callTool } from "@/lib/tool-call";
import { randomId } from "@/lib/random-id";
import { productivityFoldersQueryOptions, productivitySettingsQueryOptions } from "./api";

type FilingRule = MailProductivityPreferences["filingRules"][number];
export function AutomationSettings({
  initial,
  aiEnabled,
}: {
  readonly initial: MailProductivityPreferences;
  readonly aiEnabled: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [rule, setRule] = useState<FilingRule | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const client = useQueryClient();
  const folders = useQuery(productivityFoldersQueryOptions());
  const save = useMutation({
    // Keep drafts and review decisions unchanged until the server confirms.
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async () => {
      const parsed = mailProductivityPreferencesSchema.safeParse(draft);
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
      return callTool("mail.productivity.settings.set", parsed.data);
    },
    onSuccess: () => client.invalidateQueries(productivitySettingsQueryOptions()),
  });
  const patch = (input: Partial<MailProductivityPreferences>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...input }));
  };
  return (
    <div className="admin-stack">
      <p className="type-body-sm text-muted-foreground">
        Background preparation is optional. Suggestions never send mail or replace your drafts.
        Changes take effect after Save preferences.
      </p>
      {!aiEnabled ? (
        <p role="status">
          Your administrator has not enabled Mail AI. Reply tracking, filing and the action digest
          still work.
        </p>
      ) : null}
      <SettingToggle
        label="Prepare reply suggestions"
        description="Prepare up to five recent reply candidates per background pass."
        checked={draft.preparedReplies}
        disabled={!aiEnabled}
        onCheckedChange={(preparedReplies) => patch({ preparedReplies })}
      />
      <SettingsField
        label="Writing preferences"
        controlId="mail-writing-preferences"
        hint="Describe tone and length. Do not put passwords or API keys here."
      >
        <Textarea
          id="mail-writing-preferences"
          maxLength={2000}
          value={draft.writingInstructions}
          onChange={(event) => patch({ writingInstructions: event.target.value })}
        />
      </SettingsField>
      <SettingsField label="Follow-up reminder after days" controlId="mail-overdue-days">
        <Input
          id="mail-overdue-days"
          type="number"
          min={1}
          max={90}
          value={draft.overdueDays}
          onChange={(event) => patch({ overdueDays: Number(event.target.value) })}
        />
      </SettingsField>
      <SettingToggle
        label="Prepare upcoming meeting briefs"
        description="Prepare a private agenda brief in the hour before a meeting. Add related conversations explicitly when requesting a fuller brief."
        checked={draft.meetingBriefs}
        disabled={!aiEnabled}
        onCheckedChange={(meetingBriefs) => patch({ meetingBriefs })}
      />
      <SettingToggle
        label="Prepare a daily action digest"
        description="Private in-app preparation; no email or chat is sent automatically."
        checked={draft.dailyDigest}
        onCheckedChange={(dailyDigest) => patch({ dailyDigest })}
      />
      <SettingsField
        label="Daily digest hour (UTC)"
        controlId="mail-digest-hour"
        hint="A fixed UTC schedule avoids daylight-saving ambiguity."
      >
        <Input
          id="mail-digest-hour"
          type="number"
          min={0}
          max={23}
          value={draft.digestHourUtc}
          onChange={(event) => patch({ digestHourUtc: Number(event.target.value) })}
        />
      </SettingsField>
      <div className="flex items-center justify-between gap-2">
        <h3>Attachment filing rules</h3>
        <Button
          size="sm"
          disabled={draft.filingRules.length >= 20}
          onClick={() =>
            setRule({
              id: randomId(),
              name: "",
              enabled: true,
              folderId: "",
              criteria: { hasAttachment: true },
            })
          }
        >
          <Plus aria-hidden="true" />
          Add rule
        </Button>
      </div>
      <p className="type-caption">
        Copies go into the selected folder and follow its existing permissions. Source mail is
        preserved. Applies to new incoming mail after setup.
      </p>
      <AdminTable<FilingRule>
        label="Attachment filing rules"
        rows={draft.filingRules}
        rowKey={(row) => row.id}
        searchText={(row) => row.name}
        empty={<p>No filing rules.</p>}
        columns={[
          { id: "name", header: "Rule", cell: (row) => row.name, sortValue: (row) => row.name },
          {
            id: "state",
            header: "Status",
            cell: (row) => (row.enabled ? "Enabled" : "Paused"),
            sortValue: (row) => (row.enabled ? 1 : 0),
          },
          {
            id: "folder",
            header: "Destination",
            cell: (row) =>
              folders.data?.entries.find((folder) => folder.id === row.folderId)?.name ??
              "Folder unavailable",
          },
          {
            id: "edit",
            header: "Actions",
            cell: (row) => (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setRule(row)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    patch({
                      filingRules: draft.filingRules.map((item) =>
                        item.id === row.id ? { ...item, enabled: !item.enabled } : item,
                      ),
                    })
                  }
                >
                  {row.enabled ? "Pause" : "Enable"}
                </Button>
              </div>
            ),
          },
        ]}
      />
      {rule ? (
        <section className="admin-stack" aria-label="Edit attachment filing rule">
          <SettingsField label="Rule name" controlId="filing-name">
            <Input
              id="filing-name"
              maxLength={120}
              value={rule.name}
              onChange={(event) => setRule({ ...rule, name: event.target.value })}
            />
          </SettingsField>
          <SettingsField label="Sender contains" controlId="filing-from">
            <Input
              id="filing-from"
              value={rule.criteria.fromContains ?? ""}
              onChange={(event) =>
                setRule({
                  ...rule,
                  criteria: { ...rule.criteria, fromContains: event.target.value },
                })
              }
            />
          </SettingsField>
          <SettingsField label="Subject contains" controlId="filing-subject">
            <Input
              id="filing-subject"
              value={rule.criteria.subjectContains ?? ""}
              onChange={(event) =>
                setRule({
                  ...rule,
                  criteria: { ...rule.criteria, subjectContains: event.target.value },
                })
              }
            />
          </SettingsField>
          <SettingsField label="Destination folder" controlId="filing-folder">
            <select
              id="filing-folder"
              className="input"
              value={rule.folderId}
              onChange={(event) => setRule({ ...rule, folderId: event.target.value })}
            >
              <option value="">Choose a Drive folder</option>
              {folders.data?.entries.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </SettingsField>
          {folders.error ? <p role="alert">Folders could not load. Check Drive access.</p> : null}
          {folders.data?.nextCursor ? (
            <p>Showing the first 200 folders. Use the API to select a folder outside this list.</p>
          ) : null}
          {validation ? (
            <p role="alert" className="text-destructive">
              {validation}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRule(null);
                setValidation(null);
              }}
            >
              Cancel rule edit
            </Button>
            <Button
              onClick={() => {
                const criteria = {
                  ...rule.criteria,
                  hasAttachment: true,
                  ...(rule.criteria.fromContains?.trim()
                    ? { fromContains: rule.criteria.fromContains.trim() }
                    : {}),
                  ...(rule.criteria.subjectContains?.trim()
                    ? { subjectContains: rule.criteria.subjectContains.trim() }
                    : {}),
                };
                if (!rule.name.trim() || !rule.folderId) {
                  setValidation("Enter a rule name and choose a destination folder.");
                  return;
                }
                patch({
                  filingRules: [
                    ...draft.filingRules.filter((item) => item.id !== rule.id),
                    { ...rule, criteria },
                  ],
                });
                setRule(null);
                setValidation(null);
              }}
            >
              Keep rule changes
            </Button>
          </div>
        </section>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isSuccess ? <p role="status">Preferences saved.</p> : null}
      <Button disabled={save.isPending || rule !== null} onClick={() => save.mutate()}>
        Save preferences
      </Button>
    </div>
  );
}
