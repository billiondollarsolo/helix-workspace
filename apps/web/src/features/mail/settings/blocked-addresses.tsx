/* Blocked addresses: add one, or unblock. Saved on each change. */

import { useQuery } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { mailUserSettingsQueryOptions } from "../queries";
import { blockAddress, unblockAddress } from "./blocked-model";
import { errorText, useRetry, useSaveMailUserSettings } from "./mutations";

export function BlockedAddresses() {
  const ids = useId();
  const settings = useQuery(mailUserSettingsQueryOptions());
  const retry = useRetry(mailUserSettingsQueryOptions().queryKey);
  const save = useSaveMailUserSettings();
  const [address, setAddress] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const blocked = settings.data?.blockedSenders ?? [];

  const store = (next: readonly string[], message: string, onSaved?: () => void) =>
    save.mutate(
      { blockedSenders: [...next] },
      {
        onSuccess: () => {
          notify({ message });
          onSaved?.();
        },
      },
    );

  let body;
  if (settings.data === undefined) {
    body =
      settings.error === null ? (
        <Skeleton variant="text" count={3} label="Loading blocked addresses" className="py-4" />
      ) : (
        <InlineError
          title="Couldn't load blocked addresses"
          message={errorText(settings.error, "Check your connection and try again.")}
          onRetry={retry}
          retrying={settings.isFetching}
        />
      );
  } else if (blocked.length === 0) {
    body = (
      <EmptyState
        size="inline"
        headingLevel={3}
        icon={<Ban />}
        title="No blocked addresses"
        body="Mail from an address you block goes straight to Spam."
      />
    );
  } else {
    body = (
      <ul className="m-0 list-none p-0" aria-label="Blocked addresses">
        {blocked.map((entry) => (
          <li
            key={entry}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2"
          >
            <span className="min-w-0 break-all type-body-sm">{entry}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Unblock ${entry}`}
              disabled={save.isPending}
              onClick={() => store(unblockAddress(blocked, entry), `${entry} unblocked`)}
            >
              Unblock
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  const inputId = `${ids}-address`;
  const errorId = `${ids}-error`;
  return (
    <section aria-labelledby="mail-blocked-heading" className="mt-8">
      <h2 id="mail-blocked-heading" className="m-0 type-h3 font-semibold">
        Blocked addresses
      </h2>
      <p className="m-0 mt-0.5 mb-3 type-body-sm text-muted-foreground">
        New mail from these addresses goes to Spam.
      </p>
      <form
        noValidate
        className="mb-3 flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const result = blockAddress(blocked, address);
          if (result.kind === "error") {
            setInputError(result.message);
            return;
          }
          store(result.list, `${result.address} blocked`, () => setAddress(""));
        }}
      >
        <div className="grid min-w-0 flex-1 basis-56 gap-1">
          <label htmlFor={inputId} className="sr-only">
            Address to block
          </label>
          <input
            id={inputId}
            name="blockAddress"
            type="email"
            className="input"
            autoComplete="off"
            placeholder="name@example.com"
            value={address}
            disabled={settings.data === undefined}
            onChange={(event) => {
              setAddress(event.target.value);
              setInputError(null);
            }}
            aria-invalid={inputError !== null || undefined}
            aria-describedby={inputError === null ? undefined : errorId}
          />
          {inputError === null ? null : (
            <p id={errorId} className="m-0 type-caption text-destructive">
              {inputError}
            </p>
          )}
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-9"
          disabled={settings.data === undefined || save.isPending}
        >
          Block
        </Button>
      </form>
      {save.error === null ? null : (
        <InlineError
          className="mb-3"
          variant="compact"
          title="Couldn't update blocked addresses"
          message={errorText(save.error, "Check your connection and try again.")}
        />
      )}
      {body}
    </section>
  );
}
