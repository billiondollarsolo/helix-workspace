import type { Actor, ToolContext, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, type RuntimeToolRegistry } from "../../tool-registry.js";
import type { DriveS3AccessKeyRecord, DriveS3AccessKeyStore } from "./access-keys.js";
import { restrictDriveS3Actor } from "./access-keys.js";
import { registerDriveS3KeyTools } from "./tools.js";

const record: DriveS3AccessKeyRecord = {
  id: "8d4f546c-0dd9-44a4-b95c-d41bf8269301",
  orgId: "org",
  actorId: "user",
  accessKeyId: "HLXAAAAAAAAAAAAAAAAA",
  label: "laptop",
  scopes: ["drive.read", "drive.write"],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-11T00:00:00Z"),
};

function setup() {
  const store: DriveS3AccessKeyStore = {
    create: vi.fn(async () => ({ accessKey: record, secretAccessKey: "secret" })),
    list: vi.fn(async () => [record]),
    revoke: vi.fn(async () => ({ ...record, revokedAt: new Date() })),
    authenticate: vi.fn(async () => null),
    recordUse: vi.fn(async () => undefined),
  };
  const tools = new Map<string, ToolDefinition>();
  registerDriveS3KeyTools(
    {
      register: (tool: ToolDefinition) => tools.set(tool.id, tool),
    } as unknown as RuntimeToolRegistry,
    { store },
  );
  const run = (id: string, input: unknown, actor: Actor) => {
    const tool = tools.get(id);
    if (tool === undefined) throw new Error(`missing ${id}`);
    const ctx = { actor, audit: vi.fn(async () => undefined) } as unknown as ToolContext;
    return tool.handler(tool.inputSchema.parse(input), ctx);
  };
  return { store, tools, run };
}

const user: Actor = {
  id: "user",
  orgId: "org",
  type: "user",
  scopes: ["drive.read", "drive.write", "drive.delete"],
};

describe("drive.s3-keys tools", () => {
  it("registers confirmation-gated create and revoke tools", () => {
    const { tools } = setup();
    expect(tools.get("drive.s3-keys.create")).toMatchObject({
      permission: "drive.write",
      confirmationRequired: true,
    });
    expect(tools.get("drive.s3-keys.revoke")).toMatchObject({ confirmationRequired: true });
    expect(tools.get("drive.s3-keys.list")).toMatchObject({ permission: "drive.read" });
  });

  it("creates keys only for people, with scopes they hold, and returns the secret once", async () => {
    const { run, store } = setup();
    await expect(
      run("drive.s3-keys.create", { label: "bot" }, { ...user, type: "agent" }),
    ).rejects.toThrow(/Only people/u);
    await expect(
      run(
        "drive.s3-keys.create",
        { label: "x", scopes: ["drive.delete"] },
        {
          ...user,
          scopes: ["drive.read"],
        },
      ),
    ).rejects.toThrow(/drive.delete/u);
    const output = (await run("drive.s3-keys.create", { label: "laptop" }, user)) as {
      secretAccessKey: string;
      endpointPath: string;
    };
    expect(output.secretAccessKey).toBe("secret");
    expect(output.endpointPath).toBe("/v1/s3");
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["drive.read", "drive.write", "drive.delete"] }),
    );
  });

  it("offers and defaults to only the Drive scopes the person holds", async () => {
    const { run, store } = setup();
    const writer = { ...user, scopes: ["drive.read", "drive.write"] };
    const listed = (await run("drive.s3-keys.list", {}, writer)) as {
      grantableScopes: readonly string[];
    };
    expect(listed.grantableScopes).toEqual(["drive.read", "drive.write"]);
    await run("drive.s3-keys.create", { label: "sync" }, writer);
    expect(store.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopes: ["drive.read", "drive.write"] }),
    );
    await expect(
      run("drive.s3-keys.create", { label: "x" }, { ...user, scopes: ["mail.read"] }),
    ).rejects.toThrow(/no Drive scopes/u);
    await expect(
      run("drive.s3-keys.create", { label: "x", scopes: ["drive.read", "drive.delete"] }, writer),
    ).rejects.toThrow(/drive\.delete\. Choose from: drive\.read, drive\.write/u);
  });

  it("limits org-wide listing and cross-user revocation to admins", async () => {
    const { run, store } = setup();
    await expect(run("drive.s3-keys.list", { allActors: true }, user)).rejects.toThrow(
      /admin.users/u,
    );
    await run("drive.s3-keys.list", {}, user);
    expect(store.list).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: "user" }));
    await run("drive.s3-keys.revoke", { keyId: record.id }, user);
    expect(store.revoke).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: "user" }));
    const admin = { ...user, scopes: [...(user.scopes ?? []), "admin.users"] };
    await run("drive.s3-keys.list", { allActors: true }, admin);
    expect(store.list).toHaveBeenLastCalledWith({ orgId: "org", includeRevoked: false });
    await run("drive.s3-keys.revoke", { keyId: record.id }, admin);
    expect(store.revoke).toHaveBeenLastCalledWith({ orgId: "org", id: record.id });
  });
});

describe("drive.s3-keys.create through the registry", () => {
  it("refuses delegated OAuth, API-key, and agent credentials", async () => {
    const registry = createToolRegistry();
    const store = setup().store;
    registerDriveS3KeyTools(registry, { store });
    const delegated = await registry.invoke(
      "drive.s3-keys.create",
      { label: "minted by an app" },
      { actor: user, credentialId: "credential-1" },
    );
    expect(delegated).toMatchObject({ ok: false, statusCode: 403 });
    expect(delegated.ok ? "" : delegated.error).toContain("signed-in session");
    expect(store.create).not.toHaveBeenCalled();
    const session = await registry.invoke(
      "drive.s3-keys.create",
      { label: "laptop" },
      { actor: user },
    );
    expect(session).toMatchObject({ ok: true });
    expect(store.create).toHaveBeenCalledTimes(1);
  });
});

describe("restrictDriveS3Actor", () => {
  const authenticated = { key: record, secretAccessKey: "s", actor: user };

  it("narrows the actor to the key's grant and drops ambient authority", () => {
    expect(restrictDriveS3Actor(authenticated, "drive.read")?.scopes).toEqual([
      "drive.read",
      "drive.write",
    ]);
    expect(restrictDriveS3Actor(authenticated, "drive.delete")).toBeNull();
    expect(
      restrictDriveS3Actor({ ...authenticated, actor: { ...user, scopes: [] } }, "drive.read"),
    ).toBeNull();
    expect(
      restrictDriveS3Actor({ ...authenticated, actor: { ...user, type: "agent" } }, "drive.read"),
    ).toBeNull();
  });
});
