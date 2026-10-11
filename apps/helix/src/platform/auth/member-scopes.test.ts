import type { ActorRoleBinding } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { toolInvocationPrincipalFromRequest } from "../../api/actor.js";
import { actorHasScope } from "../../api/scopes.js";
import {
  EMPTY_CREDENTIAL_POLICY,
  type AgentCredentialRecord,
  type AgentCredentialStore,
} from "./credentials.js";
import { heldMemberScopes } from "./member-scopes.js";
import {
  hashSecret,
  InMemoryOAuthClientStore,
  OAuthTokenService,
  type AccessTokenRecord,
  type OAuthError,
} from "./oauth.js";

const ORG = "org-1";
/** The implicit org-wide binding of the built-in workspace_member role. */
const memberRole: ActorRoleBinding = {
  roleId: "workspace-member",
  allow: ["profile.read", "profile.write"],
  deny: [],
  scope: { type: "org" },
};

describe("heldMemberScopes", () => {
  it("gives people the profile scopes their membership grants", () => {
    expect(heldMemberScopes({ actorType: "user", orgId: ORG, roleBindings: [memberRole] })).toEqual(
      ["profile.read", "profile.write"],
    );
  });

  it("lets a deny in another role win, as for any binding", () => {
    const deny: ActorRoleBinding = {
      roleId: "locked",
      allow: [],
      deny: ["profile.write"],
      scope: { type: "org" },
    };
    expect(
      heldMemberScopes({ actorType: "user", orgId: ORG, roleBindings: [memberRole, deny] }),
    ).toEqual(["profile.read"]);
  });

  it("never gives agents or service accounts member scopes", () => {
    for (const actorType of ["agent", "service_account", undefined]) {
      expect(heldMemberScopes({ actorType, orgId: ORG, roleBindings: [memberRole] })).toEqual([]);
    }
  });
});

describe("client-credentials tokens for a person's own CLI login", () => {
  async function service(memberScopes: readonly string[]) {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "cli",
      clientSecretHash: await hashSecret("secret"),
      actorId: "actor-1",
      orgId: ORG,
      scopes: ["mail.read", "drive.read"],
    });
    return new OAuthTokenService({
      clientStore: store,
      tokenStore: store,
      issuer: "urn:helix:test",
      memberScopes: async () => memberScopes,
    });
  }
  const request = (scope?: string) => ({
    grantType: "client_credentials" as const,
    clientId: "cli",
    clientSecret: "secret",
    ...(scope === undefined ? {} : { scope }),
  });

  it("includes the person's profile scopes by default and on request", async () => {
    const tokens = await service(["profile.read", "profile.write"]);
    await expect(tokens.issueClientCredentialsToken(request())).resolves.toMatchObject({
      scope: "mail.read drive.read profile.read profile.write",
    });
    await expect(
      tokens.issueClientCredentialsToken(request("mail.read profile.read")),
    ).resolves.toMatchObject({ scope: "mail.read profile.read" });
  });

  it("keeps agent and service credentials to the scopes they were issued", async () => {
    const tokens = await service([]);
    await expect(tokens.issueClientCredentialsToken(request())).resolves.toMatchObject({
      scope: "mail.read drive.read",
    });
    await expect(tokens.issueClientCredentialsToken(request("profile.read"))).rejects.toMatchObject(
      {
        code: "invalid_scope",
        message: "Client is not allowed to request scope: profile.read",
      } satisfies Partial<OAuthError>,
    );
  });
});

describe("bearer tokens carrying member scopes", () => {
  const credential: AgentCredentialRecord = {
    id: "cred-1",
    credentialType: "oauth_client",
    actorId: "actor-1",
    orgId: ORG,
    scopes: ["mail.read"],
    clientId: "cli",
    secretHash: null,
    apiKeyHash: null,
    certFingerprint: null,
    label: null,
    policy: EMPTY_CREDENTIAL_POLICY,
    expiresAt: null,
    revokedAt: null,
  };
  const credentials: AgentCredentialStore = {
    findByApiKeyHash: async () => null,
    findByCertFingerprint: async () => null,
    findByClientId: async (clientId) => (clientId === "cli" ? credential : null),
  };
  const request = {
    headers: { authorization: "Bearer token-1" },
    query: {},
    raw: { socket: new Socket() },
  } as unknown as FastifyRequest;

  async function resolve(token: Partial<AccessTokenRecord>) {
    const record: AccessTokenRecord = {
      token: "token-1",
      clientId: "cli",
      actorId: "actor-1",
      orgId: ORG,
      actorType: "user",
      scopes: ["mail.read", "profile.read"],
      roleBindings: [memberRole],
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ...token,
    };
    return toolInvocationPrincipalFromRequest(
      request,
      { saveToken: async () => undefined, findToken: async () => record },
      undefined,
      credentials,
    );
  }

  it("lets a person's CLI token use profile scopes their membership still grants", async () => {
    const result = await resolve({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(actorHasScope(result.principal.actor, "profile.read")).toBe(true);
    expect(actorHasScope(result.principal.actor, "profile.write")).toBe(false);
  });

  it("refuses the token once the membership no longer grants the scope", async () => {
    await expect(resolve({ roleBindings: [] })).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      code: "credential_revoked",
    });
  });

  it("refuses profile scopes on an agent's token", async () => {
    await expect(resolve({ actorType: "agent" })).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });
});
