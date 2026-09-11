import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { mailAddressesQueryOptions, mailAddressQueryKeys } from "@/lib/mail-addresses";

export function useMailSender(initial?: string, enabled = true) {
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const addresses = useQuery({ ...mailAddressesQueryOptions(), enabled });
  const defaultAddress =
    addresses.data?.addresses.find((address) => address.isPrimary && address.sendAsEnabled)
      ?.address ?? "";
  // Capture the initial primary once, so a later admin change cannot silently switch an open draft's sender.
  useEffect(() => {
    if (enabled && selected === null && defaultAddress) setSelected(defaultAddress);
  }, [defaultAddress, enabled, selected]);
  const from = selected ?? defaultAddress;
  const available = addresses.data?.addresses.filter((address) => address.sendAsEnabled) ?? [];
  return {
    from,
    setFrom: setSelected,
    available,
    addresses,
    authorized: !addresses.isError && available.some((address) => address.address === from),
  };
}
export function MailSenderSelect({
  sender,
  disabled,
  onBlur,
}: {
  readonly sender: ReturnType<typeof useMailSender>;
  readonly disabled: boolean;
  readonly onBlur?: () => void;
}) {
  const queryClient = useQueryClient();
  return (
    <div className="space-y-1 border-b py-1">
      <label className="flex items-center gap-2 text-sm">
        <span className="w-10 shrink-0 text-muted-foreground">From</span>
        <select
          aria-label="From address"
          className="min-w-0 flex-1 bg-transparent py-1"
          disabled={disabled || sender.addresses.isPending}
          value={sender.from}
          onChange={(event) => sender.setFrom(event.target.value)}
          onBlur={onBlur}
        >
          {!sender.from ? (
            <option value="">
              {sender.addresses.isPending
                ? "Loading sending addresses…"
                : "Select a sending address"}
            </option>
          ) : null}
          {sender.from && !sender.available.some((address) => address.address === sender.from) ? (
            <option value={sender.from} disabled>
              {sender.from} (unavailable)
            </option>
          ) : null}
          {sender.available.map((address) => (
            <option key={address.address} value={address.address}>
              {address.address}
              {address.isPrimary ? " (primary)" : ""}
            </option>
          ))}
        </select>
      </label>
      {sender.addresses.isError ? (
        <p role="alert" className="text-sm">
          {sender.addresses.error.message}{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: mailAddressQueryKeys.current });
            }}
          >
            Retry sending addresses
          </button>
        </p>
      ) : !sender.addresses.isPending && !sender.authorized ? (
        <p role="alert" className="text-sm">
          Choose an available sending address. Ask an administrator if your mail address is missing.
        </p>
      ) : null}
    </div>
  );
}
