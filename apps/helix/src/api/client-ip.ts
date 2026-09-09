import { isIP } from "node:net";

/** Parse only literal proxy IPs/CIDRs; omission leaves forwarding headers untrusted. */
export function trustedProxyAddresses(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const addresses = value.split(",").map((entry) => validateProxyAddress(entry.trim()));
  return [...new Set(addresses)];
}

function validateProxyAddress(value: string): string {
  const [address, prefix, extra] = value.split("/");
  if (address === undefined || isIP(address) === 0 || extra !== undefined) {
    throw new Error("HELIX_TRUSTED_PROXIES must contain only literal IP addresses or CIDRs.");
  }
  if (prefix === undefined) return address;
  const version = isIP(address);
  const maximum = version === 4 ? 32 : 128;
  if (!/^\d{1,3}$/u.test(prefix) || Number(prefix) < 1 || Number(prefix) > maximum) {
    throw new Error("HELIX_TRUSTED_PROXIES contains an invalid CIDR prefix.");
  }
  return `${address}/${prefix}`;
}
