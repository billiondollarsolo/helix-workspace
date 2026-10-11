/* Plain-text signature and whether replies get it. */

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { MailUserSettings } from "../api";
import { mailUserSettingsQueryOptions } from "../queries";
import { errorText, useRetry, useSaveMailUserSettings } from "./mutations";
import { SettingRow } from "./setting-row";

export function SignatureForm() {
  const settings = useQuery(mailUserSettingsQueryOptions());
  const retry = useRetry(mailUserSettingsQueryOptions().queryKey);
  if (settings.data === undefined) {
    return settings.error === null ? (
      <Skeleton variant="text" count={3} label="Loading signature" className="py-4" />
    ) : (
      <InlineError
        title="Couldn't load your signature"
        message={errorText(settings.error, "Check your connection and try again.")}
        onRetry={retry}
        retrying={settings.isFetching}
      />
    );
  }
  return <SignatureFields saved={settings.data} />;
}

/** Seeded once from the saved settings, so other saves never reset an edit. */
function SignatureFields({ saved }: { readonly saved: MailUserSettings }) {
  const ids = useId();
  const save = useSaveMailUserSettings();
  const [text, setText] = useState(saved.signatureText);
  const [onReplies, setOnReplies] = useState(saved.includeSignatureOnReplies);
  const textId = `${ids}-signature`;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Only the fields shown here: an HTML signature set through the API
        // or an agent is not editable here and must survive this save.
        save.mutate({ signatureText: text, includeSignatureOnReplies: onReplies });
      }}
    >
      <SettingRow title="Signature" hint="Added to the end of messages you send" controlId={textId}>
        <textarea
          id={textId}
          name="mailSignature"
          autoComplete="off"
          rows={5}
          maxLength={40_000}
          className="input h-auto w-full resize-y p-2.5 type-body-sm [line-height:1.5]"
          placeholder="For example: Thanks, Morgan"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            save.reset();
          }}
        />
        <label className="mt-2 flex items-center gap-2 type-body-sm">
          <input
            type="checkbox"
            name="signatureOnReplies"
            className="focus-ring accent-[var(--accent)]"
            checked={onReplies}
            onChange={(event) => {
              setOnReplies(event.target.checked);
              save.reset();
            }}
          />
          Add this signature to replies
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={save.isPending}
            aria-busy={save.isPending || undefined}
          >
            Save signature
          </Button>
          <span role="status" className="type-body-sm text-muted-foreground">
            {save.isSuccess ? "Signature saved." : null}
          </span>
        </div>
        {save.error === null ? null : (
          <InlineError
            className="mt-3"
            variant="compact"
            title="Couldn't save your signature"
            message={errorText(save.error, "Check your connection and try again.")}
          />
        )}
      </SettingRow>
    </form>
  );
}
