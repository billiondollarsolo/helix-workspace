import type { VaultCommand } from "./vault-engine";
import { Debouncer } from "@tanstack/pacer/debouncer";
import type { VaultDraft, VaultListItem } from "./vault-model";

/** All keys and the complete database live in a disposable worker, never a query cache. */
export class VaultWorkerClient {
  private readonly worker = new Worker(new URL("./vault-worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 0;
  private pending: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: Debouncer<() => void>;
  } | null = null;
  private closed = false;
  constructor(private readonly onFailure: () => void) {
    this.worker.onmessage = (
      event: MessageEvent<{ id: number; result?: unknown; error?: string }>,
    ) => {
      const pending = this.pending;
      if (!pending || pending.id !== event.data.id) return;
      pending.timer.cancel();
      this.pending = null;
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.result);
    };
    this.worker.onerror = () => this.fail();
  }
  private fail() {
    if (this.closed) return;
    this.lock();
    this.onFailure();
  }
  lock() {
    this.closed = true;
    this.worker.terminate();
    if (this.pending) {
      this.pending.timer.cancel();
      this.pending.reject(new Error("Vault locked. Unlock again to continue."));
      this.pending = null;
    }
  }
  private async call<T>(command: VaultCommand): Promise<T> {
    if (this.closed) throw new Error("Vault locked. Unlock again to continue.");
    if (this.pending) throw new Error("Wait for the current vault request to finish.");
    return (await new Promise<unknown>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = new Debouncer(() => this.fail(), { wait: 60_000 });
      this.pending = { id, resolve, reject, timer };
      timer.maybeExecute();
      this.worker.postMessage({ id, command });
    })) as T;
  }
  open(password: string, data: ArrayBuffer | null) {
    return this.call<VaultListItem[]>({ kind: "open", password, data });
  }
  get(id: string) {
    return this.call<VaultDraft>({ kind: "get", id });
  }
  list() {
    return this.call<VaultListItem[]>({ kind: "list" });
  }
  save(draft: VaultDraft) {
    return this.call<ArrayBuffer>({ kind: "save", draft });
  }
  trash(id: string) {
    return this.call<ArrayBuffer>({ kind: "trash", id });
  }
  export() {
    return this.call<ArrayBuffer>({ kind: "export" });
  }
}
