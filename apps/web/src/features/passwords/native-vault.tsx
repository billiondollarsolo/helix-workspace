import type { PasswordVaultResponse } from "@helix/contracts";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import {
  downloadVault,
  readVault,
  vaultBase64,
  vaultBytes,
  VaultAccessEnded,
  writeVault,
} from "./vault-api";
import { VaultEditor } from "./vault-editor";
import type { VaultDraft, VaultListItem } from "./vault-model";
import { VaultWorkerClient } from "./vault-worker-client";

interface UnsavedVault {
  readonly ciphertext: string;
  readonly items: VaultListItem[];
  readonly expectedVersion: number;
}
const emptyDraft: VaultDraft = { name: "", username: "", password: "", website: "", notes: "" };

export function NativeVault({ actorId }: { readonly actorId: string }) {
  const id = useId();
  const [stored, setStored] = useState<PasswordVaultResponse | null>(null);
  const [items, setItems] = useState<VaultListItem[]>([]);
  const [selection, setSelection] = useState<VaultDraft | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [unsaved, setUnsaved] = useState<UnsavedVault | null>(null);
  const [discard, setDiscard] = useState(false);
  const worker = useRef<VaultWorkerClient | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const warning = useUnsavedChangesWarning(unsaved !== null, "unsaved vault", {
    message:
      "The server has not saved your changes. Stay and download your encrypted vault before leaving.",
  });

  const lock = useCallback(() => {
    active.current?.abort();
    worker.current?.lock();
    worker.current = null;
    busy.current = false;
    setPending(false);
    setUnlocked(false);
    setItems([]);
    setSelection(null);
    setSearch("");
    setError("");
    setStatus("Vault locked.");
  }, []);
  const idleLock = useDebouncer(lock, { wait: 5 * 60_000 });

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setStatus("");
    const controller = new AbortController();
    active.current = controller;
    try {
      await operation(controller.signal);
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      if (cause instanceof VaultAccessEnded) lock();
      setError(
        cause instanceof z.ZodError
          ? "The vault server returned an invalid response."
          : cause instanceof Error
            ? cause.message
            : "Couldn't complete the vault request.",
      );
    } finally {
      if (mounted.current && active.current === controller) {
        active.current = null;
        busy.current = false;
        setPending(false);
      }
    }
  }

  function load() {
    void run(async (signal) => {
      const data = await readVault(actorId, signal);
      if (signal.aborted) return;
      setStored(data);
    });
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    active.current = controller;
    busy.current = true;
    setPending(true);
    void readVault(actorId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setStored(data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Couldn't load your vault. Check your connection and retry.");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          busy.current = false;
          setPending(false);
          active.current = null;
        }
      });
    return () => {
      mounted.current = false;
      active.current?.abort();
      worker.current?.lock();
      worker.current = null;
    };
  }, [actorId]);

  useEffect(() => {
    const touch = () => {
      idleLock.maybeExecute();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") lock();
    };
    touch();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", lock);
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      idleLock.cancel();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", lock);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [lock, idleLock]);

  async function persist(candidate: UnsavedVault, signal: AbortSignal) {
    setUnsaved(candidate);
    const version = await writeVault(
      actorId,
      candidate.expectedVersion,
      candidate.ciphertext,
      signal,
    );
    if (signal.aborted) return;
    setStored((current) => ({
      previous: current?.vault ?? null,
      vault: { version, ciphertext: candidate.ciphertext, updatedAt: new Date().toISOString() },
    }));
    setUnsaved(null);
    setSelection(null);
    if (worker.current) {
      setItems(candidate.items);
      setUnlocked(true);
    }
    setStatus("Vault saved.");
  }

  function unlockVault(password: string) {
    if (busy.current || !stored || unsaved) return;
    void run(async (signal) => {
      worker.current?.lock();
      const vault = new VaultWorkerClient(() => {
        if (!mounted.current || worker.current !== vault) return;
        lock();
        setError("Vault processing stopped. Unlock your vault to continue.");
      });
      worker.current = vault;
      try {
        const list = await vault.open(
          password,
          stored.vault ? vaultBytes(stored.vault.ciphertext) : null,
        );
        if (signal.aborted) return;
        if (stored.vault === null)
          await persist(
            { ciphertext: vaultBase64(await vault.export()), items: list, expectedVersion: 0 },
            signal,
          );
        else {
          setItems(list);
          setUnlocked(true);
          setStatus("Vault unlocked.");
        }
      } catch (cause) {
        vault.lock();
        if (worker.current === vault) worker.current = null;
        throw cause;
      }
    });
  }

  function select(itemId: string) {
    void run(async (signal) => {
      const draft = await worker.current!.get(itemId);
      if (!signal.aborted) setSelection(draft);
    });
  }

  function change(draft: VaultDraft | string) {
    if (!worker.current || !stored || unsaved) return;
    void run(async (signal) => {
      const vault = worker.current!;
      const data = typeof draft === "string" ? await vault.trash(draft) : await vault.save(draft);
      const list = await vault.list();
      if (!signal.aborted)
        await persist(
          {
            ciphertext: vaultBase64(data),
            items: list,
            expectedVersion: stored.vault?.version ?? 0,
          },
          signal,
        );
    });
  }

  return (
    <section className="grid gap-4" aria-label="Personal vault">
      <p className="m-0 text-[var(--text-2)]">
        Your personal vault uses KeePass encryption. Your master password and decrypted items stay
        in this browser.
      </p>
      <p className="m-0 text-sm text-[var(--text-3)]">
        Locks when you leave this page, hide this tab, or stop using it for 5 minutes. Unsubmitted
        item drafts are cleared on lock.
      </p>
      {error ? (
        <InlineError
          message={error}
          onRetry={stored === null ? load : undefined}
          retrying={pending}
        />
      ) : null}
      <p className="m-0 text-sm text-[var(--text-2)]" role="status">
        {status}
      </p>
      {unsaved ? (
        <div className="grid gap-2 rounded-lg border border-outline p-4" role="alert">
          <p className="m-0">
            Changes have not been saved to Helix. Download an encrypted copy before discarding them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => void run((signal) => persist(unsaved, signal))}
            >
              Retry save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => downloadVault(unsaved.ciphertext, "helix-vault-unsaved.kdbx")}
            >
              Download unsaved vault
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setDiscard(true)}
            >
              Discard and reload
            </Button>
          </div>
        </div>
      ) : null}
      {stored === null && pending ? <p role="status">Loading vault…</p> : null}
      {stored === null && !pending && !error ? (
        <Button type="button" variant="outline" onClick={load}>
          Load vault
        </Button>
      ) : null}
      {stored !== null && !unlocked && !unsaved ? (
        <form
          className="grid max-w-sm gap-3"
          aria-label={stored.vault ? "Unlock vault" : "Create vault"}
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const input = event.currentTarget.elements.namedItem(
              "masterPassword",
            ) as HTMLInputElement;
            const confirmation = event.currentTarget.elements.namedItem(
              "confirmPassword",
            ) as HTMLInputElement | null;
            if (confirmation && confirmation.value !== input.value) {
              setError("Master passwords do not match.");
              return;
            }
            const password = input.value;
            input.value = "";
            if (confirmation) confirmation.value = "";
            unlockVault(password);
          }}
        >
          <h2 className="m-0 text-lg font-semibold">
            {stored.vault ? "Unlock your vault" : "Create your personal vault"}
          </h2>
          <div className="grid gap-1">
            <label htmlFor={`${id}-master`}>Master password</label>
            <input
              id={`${id}-master`}
              className="input w-full"
              name="masterPassword"
              type="password"
              required
              minLength={stored.vault ? undefined : 12}
              maxLength={1000}
              disabled={pending}
              autoComplete={stored.vault ? "current-password" : "new-password"}
              aria-describedby={`${id}-help`}
            />
            <p id={`${id}-help`} className="m-0 text-sm text-[var(--text-3)]">
              {stored.vault
                ? "Use your vault master password."
                : "Use at least 12 characters. Remember it: neither Helix nor an administrator can recover it."}
            </p>
          </div>
          {stored.vault === null ? (
            <div className="grid gap-1">
              <label htmlFor={`${id}-confirm`}>Confirm master password</label>
              <input
                id={`${id}-confirm`}
                className="input w-full"
                name="confirmPassword"
                type="password"
                required
                disabled={pending}
                autoComplete="new-password"
              />
            </div>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Opening…" : stored.vault ? "Unlock vault" : "+ Create vault"}
          </Button>
        </form>
      ) : null}
      {unlocked ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending || !!unsaved || selection !== null}
              onClick={() => setSelection(emptyDraft)}
            >
              + New item
            </Button>
            <Button type="button" variant="outline" onClick={lock}>
              Lock vault
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="grid content-start gap-3" aria-label="Vault items">
              <label htmlFor={`${id}-search`}>Search your vault</label>
              <input
                id={`${id}-search`}
                className="input w-full"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
              <ul className="m-0 grid list-none gap-2 p-0">
                {items
                  .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
                  .map((item) => (
                    <li key={item.id}>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-start overflow-hidden"
                        disabled={pending || !!unsaved || selection !== null}
                        onClick={() => select(item.id)}
                      >
                        <span className="truncate">{item.name}</span>
                      </Button>
                    </li>
                  ))}
              </ul>
              {items.length === 0 ? (
                <EmptyState
                  title="Your vault is empty"
                  body="Use + New item to save a login or secure note."
                />
              ) : null}
            </section>
            {selection ? (
              <VaultEditor
                key={selection.id ?? "new"}
                item={selection}
                pending={pending || !!unsaved}
                onSave={change}
                onClose={() => setSelection(null)}
                onTrash={() => selection.id && change(selection.id)}
              />
            ) : null}
          </div>
        </>
      ) : null}
      {stored?.vault ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => downloadVault(stored.vault!.ciphertext)}
          >
            Download saved vault
          </Button>
          {stored.previous ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                downloadVault(stored.previous!.ciphertext, "helix-vault-previous.kdbx")
              }
            >
              Download previous version
            </Button>
          ) : null}
          {!unlocked && !unsaved ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={load}>
              Reload saved vault
            </Button>
          ) : null}
        </div>
      ) : null}
      {warning}
      {discard ? (
        <Dialog
          title="Discard unsaved vault changes?"
          onClose={() => setDiscard(false)}
          footer={
            <>
              <Button type="button" variant="outline" onClick={() => setDiscard(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  lock();
                  setUnsaved(null);
                  setDiscard(false);
                  load();
                }}
              >
                Discard and reload
              </Button>
            </>
          }
        >
          <p>
            Download your unsaved vault first if you want to keep those changes. Helix will reload
            the version currently on the server.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
