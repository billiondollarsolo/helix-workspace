import { setMailUserSettings } from "@/features/mail/api";
import { mailUserSettingsQueryOptions } from "@/features/mail/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SettingsField } from "./settings-controls";

type SaveResult = { readonly kind: "saved" } | { readonly kind: "error"; readonly message: string };

/* ---------- Mail signature ---------- */

export function SignatureSection() {
  const queryClient = useQueryClient();
  const settings = useQuery(mailUserSettingsQueryOptions());
  const [signatureText, setSignatureText] = useState("");
  const [includeOnReplies, setIncludeOnReplies] = useState(true);
  const [blockedSenders, setBlockedSenders] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    if (settings.data === undefined) return;
    setSignatureText(settings.data.signatureText);
    setIncludeOnReplies(settings.data.includeSignatureOnReplies);
    setBlockedSenders(settings.data.blockedSenders.join("\n"));
  }, [settings.data]);

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      // Send only the fields this form edits: an HTML signature set through
      // the API or an agent is not shown here, so it must not be cleared.
      const saved = await setMailUserSettings({
        signatureText,
        includeSignatureOnReplies: includeOnReplies,
        blockedSenders: blockedSenders
          .split(/[\s,]+/u)
          .map((address) => address.trim().toLowerCase())
          .filter(Boolean),
      });
      // Reopening the section re-seeds from this cache entry, so it must hold
      // the saved record rather than the value loaded before the edit.
      queryClient.setQueryData(mailUserSettingsQueryOptions().queryKey, saved);
      setResult({ kind: "saved" });
    } catch (error) {
      setResult({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not save mail settings.",
      });
    } finally {
      setSaving(false);
    }
  };

  const disabled = settings.isPending || saving;
  return (
    <>
      <h1 className="type-h2 font-semibold [margin:0_0_4px]">Mail signature</h1>
      <div className="type-body-sm text-muted-foreground mb-2">
        Added to every email you send from Helix Mail
      </div>
      <SettingsField label="Signature" controlId="settings-mail-signature">
        <textarea
          id="settings-mail-signature"
          name="mailSignature"
          autoComplete="off"
          className="input [height:auto] p-2.5 [resize:vertical] [font-family:inherit] [line-height:1.5] type-body-sm"
          value={signatureText}
          onChange={(event) => setSignatureText(event.target.value)}
          placeholder="For example, Thanks, Morgan…"
          rows={5}
          disabled={disabled}
        />
      </SettingsField>
      <SettingsField label="Reply behavior" controlId="settings-reply-signature">
        <select
          id="settings-reply-signature"
          name="replySignature"
          className="select"
          value={includeOnReplies ? "include" : "skip"}
          onChange={(event) => setIncludeOnReplies(event.target.value === "include")}
          disabled={disabled}
        >
          <option value="include">Include signature on replies</option>
          <option value="skip">Skip on replies</option>
        </select>
      </SettingsField>
      <SettingsField
        label="Blocked senders"
        hint="One email address per line; future messages go to Spam"
        controlId="settings-blocked-senders"
      >
        <textarea
          id="settings-blocked-senders"
          name="blockedSenders"
          autoComplete="off"
          className="input [height:auto] p-2.5 [resize:vertical] [font-family:inherit]"
          value={blockedSenders}
          onChange={(event) => setBlockedSenders(event.target.value)}
          rows={4}
          disabled={disabled}
        />
      </SettingsField>
      {settings.error !== null ? <div role="alert">{settings.error.message}</div> : null}
      {result?.kind === "error" ? <div role="alert">{result.message}</div> : null}
      {result?.kind === "saved" ? <div role="status">Mail settings saved.</div> : null}
      <button
        type="button"
        className="btn primary sm"
        disabled={disabled}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save mail settings"}
      </button>
    </>
  );
}
