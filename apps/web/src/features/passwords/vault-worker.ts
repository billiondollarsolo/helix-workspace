import { KdbxError } from "kdbxweb";
import { VaultEngine, type VaultCommand } from "./vault-engine";

const vault = new VaultEngine();
self.onmessage = async (event: MessageEvent<{ id: number; command: VaultCommand }>) => {
  const { id, command } = event.data;
  try {
    let result: unknown;
    switch (command.kind) {
      case "open":
        result = await vault.open(command.password, command.data);
        break;
      case "get":
        result = vault.get(command.id);
        break;
      case "list":
        result = vault.list();
        break;
      case "save":
        result = await vault.save(command.draft);
        break;
      case "trash":
        result = await vault.trash(command.id);
        break;
      case "export":
        result = await vault.export();
        break;
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error:
        error instanceof KdbxError && error.code === "InvalidKey"
          ? "Couldn't unlock. Check your master password."
          : command.kind === "open"
            ? "Couldn't open this vault. It may be damaged or use an unsupported format."
            : "Couldn't update this vault. Your encrypted saved copy has not been changed.",
    });
  }
};
