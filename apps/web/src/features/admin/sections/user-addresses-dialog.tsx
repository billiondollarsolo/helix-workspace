import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  addMailAddress,
  mailAddressesQueryOptions,
  mailAddressQueryKeys,
  removeMailAddress,
  setPrimaryMailAddress,
  updateMailAddress,
  type MailAddresses,
  type MailSendingAddress,
} from "@/lib/mail-addresses";
import { sessionQueryKeys } from "@/lib/auth";
import { profileQueryKeys } from "@/lib/profile";
import { MailAddressInput } from "../mail-address-input";
import { StateBanner } from "../console/primitives";

function AdminUserAddressesDialog({
  actorId,
  name,
  onClose,
}: {
  readonly actorId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const addresses = useQuery(mailAddressesQueryOptions(actorId));
  const [primary, setPrimary] = useState("");
  const [alias, setAlias] = useState("");
  const [receiveEnabled, setReceiveEnabled] = useState(true);
  const [sendAsEnabled, setSendAsEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function save(action: () => Promise<MailAddresses>, message: string, reset?: () => void) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      queryClient.setQueryData(mailAddressQueryKeys.byActor(actorId), result);
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
      void queryClient.invalidateQueries({ queryKey: mailAddressQueryKeys.current });
      void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.current });
      void queryClient.invalidateQueries({ queryKey: profileQueryKeys.current });
      setNotice(message);
      reset?.();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update mail addresses. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  function changeAlias(
    address: MailSendingAddress,
    key: "receiveEnabled" | "sendAsEnabled",
    value: boolean,
  ) {
    if (address.id !== null)
      void save(
        () => updateMailAddress(actorId, address.id!, { [key]: value }),
        "Alias settings saved.",
      );
  }
  return (
    <Dialog
      title={`Mail addresses for ${name}`}
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          These addresses deliver to one user. Changing the primary mail address keeps the former
          primary as an alias. The account’s sign-in email stays unchanged.
        </p>
        {addresses.isPending ? (
          <StateBanner kind="loading">Loading mail addresses…</StateBanner>
        ) : null}
        {addresses.isError ? (
          <StateBanner kind="error">
            {addresses.error.message}{" "}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: mailAddressQueryKeys.byActor(actorId),
                });
              }}
            >
              Retry addresses
            </Button>
          </StateBanner>
        ) : null}
        {addresses.data ? (
          <>
            <section aria-label="Current mail addresses" className="space-y-3">
              <p className="text-sm">
                <strong>Primary mail address:</strong>{" "}
                {addresses.data.primaryEmail ?? "Not configured"}
              </p>
              <p className="text-sm">
                <strong>Login email:</strong> {addresses.data.loginEmail ?? "Not available"}
              </p>
              <ul className="space-y-3">
                {addresses.data.addresses.map((address) => (
                  <li key={address.address} className="space-y-2 rounded-md border p-3">
                    <p className="break-all text-sm font-medium">{address.address}</p>
                    {address.source === "alias" && !address.isPrimary && address.id !== null ? (
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={address.receiveEnabled}
                            disabled={pending}
                            onChange={(event) =>
                              changeAlias(address, "receiveEnabled", event.target.checked)
                            }
                          />
                          Receive mail at {address.address}
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={address.sendAsEnabled}
                            disabled={pending}
                            onChange={(event) =>
                              changeAlias(address, "sendAsEnabled", event.target.checked)
                            }
                          />
                          Send as {address.address}
                        </label>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            void save(
                              () => removeMailAddress(actorId, address.id!),
                              "Alias removed.",
                            );
                          }}
                          aria-label={`Remove alias ${address.address}`}
                        >
                          Remove alias
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {address.isPrimary
                          ? "Primary address"
                          : "Automatic domain alias — managed in Domains"}{" "}
                        · {address.receiveEnabled ? "Receives mail" : "Receiving unavailable"} ·{" "}
                        {address.sendAsEnabled ? "Can send mail" : "Sending unavailable"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save(
                  () => setPrimaryMailAddress(actorId, primary),
                  "Primary mail address changed.",
                  () => setPrimary(""),
                );
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <legend className="text-sm font-semibold">Change primary mail address</legend>
                <MailAddressInput
                  label="Primary address"
                  value={primary}
                  purpose="primary"
                  onChange={setPrimary}
                  domains={addresses.data.eligibleDomains}
                />
                <Button type="submit" disabled={primary.length === 0}>
                  Set primary address
                </Button>
              </fieldset>
            </form>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save(
                  () => addMailAddress(actorId, { address: alias, receiveEnabled, sendAsEnabled }),
                  "Alias added.",
                  () => setAlias(""),
                );
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <legend className="text-sm font-semibold">Add an email alias</legend>
                <MailAddressInput
                  label="Alias"
                  value={alias}
                  purpose="alias"
                  onChange={setAlias}
                  domains={addresses.data.eligibleDomains}
                />
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={receiveEnabled}
                      onChange={(event) => setReceiveEnabled(event.target.checked)}
                    />
                    Receive mail
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={sendAsEnabled}
                      onChange={(event) => setSendAsEnabled(event.target.checked)}
                    />
                    Allow sending as this alias
                  </label>
                </div>
                <Button type="submit" disabled={alias.length === 0}>
                  Add alias
                </Button>
              </fieldset>
            </form>
          </>
        ) : null}
        {error ? <StateBanner kind="error">{error}</StateBanner> : null}
        {notice ? <StateBanner kind="info">{notice}</StateBanner> : null}
      </div>
    </Dialog>
  );
}

export function AdminUserAddressesButton({
  actorId,
  name,
}: {
  readonly actorId: string;
  readonly name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={`Manage mail addresses for ${name}`}
      >
        Mail addresses
      </Button>
      {open ? (
        <AdminUserAddressesDialog actorId={actorId} name={name} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
