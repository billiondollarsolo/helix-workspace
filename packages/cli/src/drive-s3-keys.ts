/**
 * `helix drive s3-keys list|revoke`: inspect and revoke the caller's S3 access
 * keys for the Drive S3 API. Creating a key needs a signed-in web session, so
 * the CLI's delegated token cannot mint one; use Settings → S3 access keys.
 */
const driveS3KeysUsage =
  "Usage: helix drive s3-keys <list|revoke> [--json [JSON]] (create keys in Settings → S3 access keys)";
const driveS3KeysListUsage =
  "Usage: helix drive s3-keys list [--include-revoked] [--all] [--json [JSON]]";
const driveS3KeysRevokeUsage = "Usage: helix drive s3-keys revoke --key-id <id> [--json [JSON]]";

export type DriveS3KeysParse =
  | {
      readonly toolId: string;
      /** Inline JSON input, or `null` when the caller passed `--json`. */
      readonly input: string | null;
    }
  | { readonly usage: string };

interface FlagSpec {
  readonly strings: ReadonlyMap<string, string>;
  readonly booleans: ReadonlyMap<string, string>;
}

const SPECS: Readonly<Record<string, { toolId: string; usage: string; flags: FlagSpec }>> = {
  list: {
    toolId: "drive.s3-keys.list",
    usage: driveS3KeysListUsage,
    flags: {
      strings: new Map<string, string>(),
      booleans: new Map([
        ["--include-revoked", "includeRevoked"],
        ["--all", "allActors"],
      ]),
    },
  },
  revoke: {
    toolId: "drive.s3-keys.revoke",
    usage: driveS3KeysRevokeUsage,
    flags: {
      strings: new Map([["--key-id", "keyId"]]),
      booleans: new Map<string, string>(),
    },
  },
};

export function parseDriveS3KeysCommand(
  action: string | undefined,
  args: readonly string[],
): DriveS3KeysParse {
  const spec = action === undefined ? undefined : SPECS[action];
  if (spec === undefined) return { usage: driveS3KeysUsage };
  if (args[0] === "--json") return { toolId: spec.toolId, input: null };
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    const booleanKey = spec.flags.booleans.get(flag);
    if (booleanKey !== undefined) {
      input[booleanKey] = true;
      continue;
    }
    const stringKey = spec.flags.strings.get(flag);
    const value = args[index + 1];
    if (stringKey === undefined || value === undefined) return { usage: spec.usage };
    input[stringKey] = value;
    index += 1;
  }
  if (action === "revoke" && input.keyId === undefined) return { usage: spec.usage };
  return { toolId: spec.toolId, input: JSON.stringify(input) };
}
