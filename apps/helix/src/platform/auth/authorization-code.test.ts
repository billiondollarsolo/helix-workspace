import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthorizationCodeService,
  InMemoryAuthorizationCodeStore,
  hashAuthorizationCode,
  isValidCodeChallenge,
  verifyPkce,
} from "./authorization-code.js";
import { OAuthError } from "./oauth.js";

function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const baseIssueInput = (challenge: string, method: "S256" | "plain" = "S256") => ({
  clientId: "client-1",
  actorId: "actor-1",
  orgId: "org-1",
  redirectUri: "https://app.example.com/callback",
  scopes: ["mail.read", "chat.read"],
  codeChallenge: challenge,
  codeChallengeMethod: method,
  state: "xyz",
});

describe("PKCE verification", () => {
  it("verifies an S256 challenge against its verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(challenge, "S256", verifier)).toBe(true);
  });

  it("rejects a tampered verifier", () => {
    const { challenge } = pkcePair();
    const wrong = randomBytes(48).toString("base64url");
    expect(verifyPkce(challenge, "S256", wrong)).toBe(false);
  });

  it("supports the plain method", () => {
    const verifier = randomBytes(48).toString("base64url");
    expect(verifyPkce(verifier, "plain", verifier)).toBe(true);
    expect(verifyPkce(verifier, "plain", `${verifier}x`)).toBe(false);
  });

  it("validates code_challenge length and charset", () => {
    expect(isValidCodeChallenge("a".repeat(43))).toBe(true);
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(129))).toBe(false);
    expect(isValidCodeChallenge(`${"a".repeat(43)} space`)).toBe(false);
  });
});

describe("AuthorizationCodeService", () => {
  it("issues and redeems a code (happy path)", async () => {
    const { verifier, challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));

    const redeemed = await service.redeemCode({
      code,
      clientId: "client-1",
      redirectUri: "https://app.example.com/callback",
      codeVerifier: verifier,
    });
    expect(redeemed.actorId).toBe("actor-1");
    expect(redeemed.orgId).toBe("org-1");
    expect(redeemed.scopes).toEqual(["mail.read", "chat.read"]);
  });

  it("rejects a code with a tampered verifier", async () => {
    const { challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));

    await expect(
      service.redeemCode({
        code,
        clientId: "client-1",
        redirectUri: "https://app.example.com/callback",
        codeVerifier: randomBytes(48).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects a code reused a second time (single-use)", async () => {
    const { verifier, challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));
    const redeem = () =>
      service.redeemCode({
        code,
        clientId: "client-1",
        redirectUri: "https://app.example.com/callback",
        codeVerifier: verifier,
      });
    await expect(redeem()).resolves.toMatchObject({ actorId: "actor-1" });
    await expect(redeem()).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects a redirect_uri that does not match the authorization request", async () => {
    const { verifier, challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));
    await expect(
      service.redeemCode({
        code,
        clientId: "client-1",
        redirectUri: "https://attacker.example.com/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects a code redeemed by a different client", async () => {
    const { verifier, challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));
    await expect(
      service.redeemCode({
        code,
        clientId: "client-2",
        redirectUri: "https://app.example.com/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects an expired code", async () => {
    const { verifier, challenge } = pkcePair();
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
      codeTtlSeconds: -1,
    });
    const { code } = await service.issueCode(baseIssueInput(challenge));
    await expect(
      service.redeemCode({
        code,
        clientId: "client-1",
        redirectUri: "https://app.example.com/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects an unknown code", async () => {
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    await expect(
      service.redeemCode({
        code: "helix_ac_unknown",
        clientId: "client-1",
        redirectUri: "https://app.example.com/callback",
        codeVerifier: randomBytes(48).toString("base64url"),
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects issuing a code with an invalid challenge", async () => {
    const service = new AuthorizationCodeService({
      codeStore: new InMemoryAuthorizationCodeStore(),
    });
    await expect(service.issueCode(baseIssueInput("too-short"))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("only stores a hash of the issued code", async () => {
    const { challenge } = pkcePair();
    const store = new InMemoryAuthorizationCodeStore();
    const service = new AuthorizationCodeService({ codeStore: store });
    const { code, record } = await service.issueCode(baseIssueInput(challenge));
    expect(record.codeHash).toBe(hashAuthorizationCode(code));
    expect(record.codeHash).not.toBe(code);
  });
});
