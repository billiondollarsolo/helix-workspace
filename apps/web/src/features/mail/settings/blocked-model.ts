/* Blocked addresses: mail from them goes straight to Spam. Stored lower-case. */

const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/u;
/** The API's limit. */
const MAX_BLOCKED = 1000;

type BlockResult =
  | { readonly kind: "ok"; readonly list: readonly string[]; readonly address: string }
  | { readonly kind: "error"; readonly message: string };

export function blockAddress(list: readonly string[], input: string): BlockResult {
  const address = input.trim().toLowerCase();
  if (address === "") return { kind: "error", message: "Enter an email address to block." };
  if (!ADDRESS.test(address)) {
    return { kind: "error", message: "Enter a full email address, like name@example.com." };
  }
  if (list.includes(address)) {
    return { kind: "error", message: `${address} is already blocked.` };
  }
  if (list.length >= MAX_BLOCKED) {
    return {
      kind: "error",
      message: `You can block up to ${MAX_BLOCKED.toLocaleString()} addresses. Unblock one first.`,
    };
  }
  return { kind: "ok", list: [...list, address].sort(), address };
}

export function unblockAddress(list: readonly string[], address: string): readonly string[] {
  return list.filter((entry) => entry !== address);
}
