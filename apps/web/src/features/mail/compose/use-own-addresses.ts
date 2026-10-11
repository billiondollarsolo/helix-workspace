import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { mailAddressesQueryOptions } from "@/lib/mail-addresses";

/** Every address that is "me" (primary, aliases, login), lower-cased; `ready` once known. */
export function useOwnAddresses(): { readonly own: ReadonlySet<string>; readonly ready: boolean } {
  const addresses = useQuery(mailAddressesQueryOptions());
  const own = useMemo(() => {
    const data = addresses.data;
    if (data === undefined) return new Set<string>();
    return new Set(
      [
        ...data.addresses.map((entry) => entry.address),
        ...(data.primaryEmail === null ? [] : [data.primaryEmail]),
        ...(data.loginEmail === null ? [] : [data.loginEmail]),
      ].map((address) => address.toLowerCase()),
    );
  }, [addresses.data]);
  return { own, ready: !addresses.isPending };
}
