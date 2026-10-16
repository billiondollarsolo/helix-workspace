import { PASSWORD_VAULT_MAX_BYTES } from "@helix/contracts";
import { argon2d, argon2id } from "hash-wasm";
import {
  BinaryStream,
  ByteUtils,
  Consts,
  CryptoEngine,
  Int64,
  Kdbx,
  KdbxContext,
  KdbxHeader,
  ProtectedValue,
  Credentials,
  VarDictionary,
  type KdbxEntry,
} from "kdbxweb";
import { vaultDraftSchema, type VaultDraft, type VaultListItem } from "./vault-model";
export type VaultCommand =
  | { readonly kind: "open"; readonly password: string; readonly data: ArrayBuffer | null }
  | { readonly kind: "get"; readonly id: string }
  | { readonly kind: "list" }
  | { readonly kind: "save"; readonly draft: VaultDraft }
  | { readonly kind: "trash"; readonly id: string }
  | { readonly kind: "export" };

CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type, version) => {
    if (
      version !== 0x13 ||
      memory < 16384 ||
      memory > 65536 ||
      iterations < 2 ||
      iterations > 10 ||
      parallelism < 1 ||
      parallelism > 4 ||
      length !== 32
    )
      throw new Error("Unsupported vault key derivation settings.");
    const derive = type === CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
    const result = await derive({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      parallelism,
      hashLength: length,
      outputType: "binary",
    });
    return result.buffer as ArrayBuffer;
  },
);

function text(entry: KdbxEntry, field: string): string {
  const value = entry.fields.get(field);
  return value instanceof ProtectedValue ? value.getText() : (value ?? "");
}

export class VaultEngine {
  private database: Kdbx | undefined;

  async open(password: string, data: ArrayBuffer | null): Promise<VaultListItem[]> {
    this.database = undefined;
    const credentials = new Credentials(ProtectedValue.fromString(password));
    if (data === null) {
      const db = Kdbx.create(credentials, "Helix personal vault");
      db.setKdf(Consts.KdfId.Argon2id);
      db.header.compression = Consts.CompressionAlgorithm.None;
      const parameters = db.header.kdfParameters!;
      parameters.set("M", VarDictionary.ValueType.UInt64, Int64.from(32 * 1024 * 1024));
      parameters.set("I", VarDictionary.ValueType.UInt64, Int64.from(3));
      parameters.set("P", VarDictionary.ValueType.UInt32, 2);
      parameters.set("V", VarDictionary.ValueType.UInt32, 0x13);
      this.database = db;
    } else {
      if (data.byteLength > PASSWORD_VAULT_MAX_BYTES) throw new Error("Vault is too large.");
      const placeholder = Kdbx.create(credentials, "");
      const header = KdbxHeader.read(
        new BinaryStream(data),
        new KdbxContext({ kdbx: placeholder }),
      );
      // shortcut: uncompressed KDBX 4 with Argon2 only; expand imports after bounded decompression/AES-KDF tests.
      if (
        header.versionMajor !== 4 ||
        header.compression !== Consts.CompressionAlgorithm.None ||
        !(header.kdfParameters?.get("$UUID") instanceof ArrayBuffer) ||
        !new Set<string>([Consts.KdfId.Argon2id, Consts.KdfId.Argon2d]).has(
          ByteUtils.bytesToBase64(header.kdfParameters.get("$UUID") as ArrayBuffer),
        )
      ) {
        throw new Error("Unsupported vault format.");
      }
      this.database = await Kdbx.load(data, credentials);
    }
    return this.list();
  }

  private db(): Kdbx {
    if (!this.database) throw new Error("Vault is locked.");
    return this.database;
  }

  private entries(): KdbxEntry[] {
    const db = this.db();
    const recycleBin = db.meta.recycleBinUuid?.id;
    return Array.from(db.getDefaultGroup().allEntries()).filter((entry) => {
      for (let group = entry.parentGroup; group; group = group.parentGroup)
        if (group.uuid.id === recycleBin) return false;
      return true;
    });
  }

  list(): VaultListItem[] {
    return this.entries().map((entry) => ({
      id: entry.uuid.id,
      name: text(entry, "Title"),
      username: text(entry, "UserName"),
    }));
  }

  get(id: string): VaultDraft {
    const entry = this.entries().find((item) => item.uuid.id === id);
    if (!entry) throw new Error("Item is no longer available.");
    return {
      id,
      name: text(entry, "Title"),
      username: text(entry, "UserName"),
      password: text(entry, "Password"),
      website: text(entry, "URL"),
      notes: text(entry, "Notes"),
    };
  }

  async save(input: VaultDraft): Promise<ArrayBuffer> {
    const draft = vaultDraftSchema.parse(input);
    const db = this.db();
    const existing = draft.id
      ? this.entries().find((entry) => entry.uuid.id === draft.id)
      : undefined;
    if (draft.id && !existing) throw new Error("Item is no longer available.");
    const entry = existing ?? db.createEntry(db.getDefaultGroup());
    if (existing) entry.pushHistory();
    for (const [field, value] of [
      ["Title", draft.name],
      ["UserName", draft.username],
      ["Password", draft.password],
      ["URL", draft.website],
      ["Notes", draft.notes],
    ]) {
      entry.fields.set(field!, ProtectedValue.fromString(value!));
    }
    entry.times.update();
    return this.export();
  }

  async trash(id: string): Promise<ArrayBuffer> {
    const entry = this.entries().find((item) => item.uuid.id === id);
    if (!entry) throw new Error("Item is no longer available.");
    this.db().remove(entry);
    return this.export();
  }

  async export(): Promise<ArrayBuffer> {
    const data = await this.db().save();
    if (data.byteLength > PASSWORD_VAULT_MAX_BYTES)
      throw new Error("Vault exceeds the 1 MiB storage limit.");
    return data;
  }
}
