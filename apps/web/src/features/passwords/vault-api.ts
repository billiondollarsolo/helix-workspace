import { passwordVaultResponseSchema, type PasswordVaultResponse } from "@helix/contracts";
import { z } from "zod";
import { Debouncer } from "@tanstack/pacer/debouncer";
import { authenticatedFetch } from "@/lib/auth";

export class VaultAccessEnded extends Error {}
async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403)
    throw new VaultAccessEnded(
      "Vault access ended. Sign in again or ask an administrator to check availability.",
    );
  if (response.status === 409)
    throw new Error(
      "This vault changed in another tab. Download your unsaved vault, then reload the saved copy.",
    );
  if (!response.ok)
    throw new Error("Couldn't save or load your vault. Check your connection and retry.");
  return response.json();
}
export async function readVault(
  actorId: string,
  signal: AbortSignal,
): Promise<PasswordVaultResponse> {
  return passwordVaultResponseSchema.parse(
    await responseJson(
      await authenticatedFetch("/api/passwords/vault", {
        signal,
        cache: "no-store",
        headers: { "x-helix-vault-owner": actorId },
      }),
    ),
  );
}
export async function writeVault(
  actorId: string,
  expectedVersion: number,
  ciphertext: string,
  signal: AbortSignal,
): Promise<number> {
  return z.object({ version: z.number().int().positive() }).parse(
    await responseJson(
      await authenticatedFetch("/api/passwords/vault", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-helix-vault-owner": actorId },
        body: JSON.stringify({ expectedVersion, ciphertext }),
        signal,
      }),
    ),
  ).version;
}
export function vaultBytes(ciphertext: string): ArrayBuffer {
  return Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0)).buffer;
}
export function vaultBase64(data: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function downloadVault(ciphertext: string, name = "helix-vault.kdbx") {
  const url = URL.createObjectURL(
    new Blob([vaultBytes(ciphertext)], { type: "application/x-keepass2" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  new Debouncer(() => URL.revokeObjectURL(url), { wait: 1000 }).maybeExecute();
}
