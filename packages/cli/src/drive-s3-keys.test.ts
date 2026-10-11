import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "./parser.js";

describe("helix drive s3-keys", () => {
  it("lists and revokes keys", () => {
    expect(parseCliArgs(["drive", "s3-keys", "list", "--include-revoked", "--all"])).toEqual({
      kind: "tool-call",
      toolId: "drive.s3-keys.list",
      json: { source: "inline", value: '{"includeRevoked":true,"allActors":true}' },
    });
    expect(
      parseCliArgs([
        "drive",
        "s3-keys",
        "revoke",
        "--key-id",
        "8d4f546c-0dd9-44a4-b95c-d41bf8269301",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "drive.s3-keys.revoke",
      json: { source: "inline", value: '{"keyId":"8d4f546c-0dd9-44a4-b95c-d41bf8269301"}' },
    });
  });

  it("passes --json through and points key creation to the web settings", () => {
    expect(parseCliArgs(["drive", "s3-keys", "list", "--json", "{}"])).toMatchObject({
      kind: "tool-call",
      toolId: "drive.s3-keys.list",
    });
    expect(() => parseCliArgs(["drive", "s3-keys", "revoke"])).toThrow(/--key-id/u);
    expect(() => parseCliArgs(["drive", "s3-keys", "create", "--label", "x"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["drive", "s3-keys", "create"])).toThrow(/Settings/u);
  });
});
