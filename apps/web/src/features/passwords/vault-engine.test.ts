import { describe, expect, it } from "vitest";
import { Credentials, Kdbx, ProtectedValue, Consts, Int64, VarDictionary } from "kdbxweb";
import { VaultEngine } from "./vault-engine";

const password = "fixture-vault-password-2026";
const draft = {
  name: "Example login",
  username: "Mike",
  password: "fake-entry-secret",
  website: "https://example.test",
  notes: "Unicode café 日本語",
};

describe("KeePass native vault", () => {
  it("encrypts, reopens, edits without duplication, and recycles items with their history", async () => {
    const vault = new VaultEngine();
    expect(await vault.open(password, null)).toEqual([]);
    const data = await vault.save(draft);
    const serialized = new TextDecoder().decode(data);
    for (const plain of [password, draft.name, draft.username, draft.password, draft.notes])
      expect(serialized).not.toContain(plain);
    const reopened = new VaultEngine();
    const [item] = await reopened.open(password, data);
    expect(item).toMatchObject({ name: draft.name, username: draft.username });
    expect(reopened.get(item!.id)).toMatchObject(draft);
    const edited = await reopened.save({ ...draft, id: item!.id, notes: "Updated note" });
    const db = await Kdbx.load(edited, new Credentials(ProtectedValue.fromString(password)));
    expect(db.header.kdfParameters!.get("$UUID")).toEqual(
      new Uint8Array(
        atob(Consts.KdfId.Argon2id)
          .split("")
          .map((c) => c.charCodeAt(0)),
      ).buffer,
    );
    expect(db.getDefaultGroup().entries).toHaveLength(1);
    expect(db.getDefaultGroup().entries[0]!.history).toHaveLength(1);
    const removed = await reopened.trash(item!.id);
    expect(reopened.list()).toEqual([]);
    const recovered = await Kdbx.load(
      removed,
      new Credentials(ProtectedValue.fromString(password)),
    );
    const bin = recovered.getGroup(recovered.meta.recycleBinUuid!);
    expect(bin?.entries).toHaveLength(1);
  });

  it("rejects wrong passwords, tampering, compressed imports, and excessive KDF work", async () => {
    const vault = new VaultEngine();
    await vault.open(password, null);
    const data = await vault.save(draft);
    await expect(new VaultEngine().open("wrong password", data)).rejects.toThrow();
    const tampered = data.slice(0);
    const changed = new Uint8Array(tampered);
    changed[changed.length - 50] = changed[changed.length - 50]! ^ 1;
    await expect(new VaultEngine().open(password, tampered)).rejects.toThrow();
    const db = await Kdbx.load(data, new Credentials(ProtectedValue.fromString(password)));
    db.header.compression = Consts.CompressionAlgorithm.GZip;
    await expect(new VaultEngine().open(password, await db.save())).rejects.toThrow(
      "Unsupported vault format",
    );
    db.header.compression = Consts.CompressionAlgorithm.None;
    db.header.kdfParameters!.set(
      "M",
      VarDictionary.ValueType.UInt64,
      Int64.from(128 * 1024 * 1024),
    );
    await expect(db.save()).rejects.toThrow("Unsupported vault key derivation settings");
  });
});
