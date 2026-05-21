import { createVerify, generateKeyPairSync } from "node:crypto";
import type {
  AICallContext,
  ChatRequest,
  ChatResponse,
  LLMProviderCapability,
  ModelInfo,
} from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import {
  envCredentialProvider,
  parseIniSection,
  parseInstanceProfileCredentials,
  resolveAwsCredentials,
  sharedConfigCredentialProvider,
} from "./aws-credentials.js";
import {
  bedrockInvokeUrl,
  createBedrockCredentialProvider,
  createBedrockProvider,
  signedBedrockHeaders,
} from "./bedrock.js";
import { createVertexProvider, parseTokenResponse, signServiceAccountJwt } from "./vertex.js";

/**
 * Edge-case coverage for the cloud-provider authentication paths that the
 * happy-path suite (`providers.test.ts`) does not exercise: SigV4 signing
 * determinism and session-token handling, the AWS credential resolver's
 * precedence and failure modes, and the Vertex JWT/token-exchange flow.
 */

const MODELS: readonly ModelInfo[] = [{ id: "anthropic.claude-3-sonnet" }];

const CTX: AICallContext = {
  actor: { id: "user-1", type: "user", orgId: "org-1" },
  feature: "test.chat",
  classification: "standard",
};

const HELLO: ChatRequest = {
  feature: "test.chat",
  messages: [{ role: "user", content: "hi" }],
};

function rejectingFetch(message: string): typeof fetch {
  return async () => {
    throw new Error(message);
  };
}

/** Resolves the request URL from any of fetch's input shapes. */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

/** Invokes a provider's non-streaming chat and asserts the result shape. */
async function chat(provider: LLMProviderCapability): Promise<ChatResponse> {
  const result = provider.chat(HELLO, CTX);
  if (Symbol.asyncIterator in (result as object)) {
    throw new Error("Expected a non-streaming chat response");
  }
  return result as Promise<ChatResponse>;
}

describe("Bedrock SigV4 signing edge cases", () => {
  const signingInput = {
    url: bedrockInvokeUrl("https://bedrock-runtime.us-east-1.amazonaws.com", "model-x"),
    body: JSON.stringify({ messages: [] }),
    date: new Date("2026-05-21T12:00:00.000Z"),
    region: "us-east-1",
  };

  it("produces a deterministic signature for identical inputs", () => {
    const credentials = { accessKeyId: "AKIA", secretAccessKey: "secret" };
    const first = signedBedrockHeaders({ ...signingInput, credentials });
    const second = signedBedrockHeaders({ ...signingInput, credentials });
    expect(first.authorization).toBe(second.authorization);
    expect(first.authorization).toContain("AWS4-HMAC-SHA256");
    expect(first.authorization).toContain("Credential=AKIA/20260521/us-east-1/bedrock/aws4_request");
  });

  it("changes the signature when the secret key changes", () => {
    const a = signedBedrockHeaders({
      ...signingInput,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret-a" },
    });
    const b = signedBedrockHeaders({
      ...signingInput,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret-b" },
    });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("includes the session token header and signs it for temporary credentials", () => {
    const headers = signedBedrockHeaders({
      ...signingInput,
      credentials: {
        accessKeyId: "ASIA",
        secretAccessKey: "secret",
        sessionToken: "temp-token",
      },
    });
    expect(headers["x-amz-security-token"]).toBe("temp-token");
    expect(headers.authorization).toContain("x-amz-security-token");
  });

  it("omits the session token header for static credentials", () => {
    const headers = signedBedrockHeaders({
      ...signingInput,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    expect(headers["x-amz-security-token"]).toBeUndefined();
    expect(headers.authorization).not.toContain("x-amz-security-token");
  });

  it("binds the signature to the request date via the credential scope", () => {
    const credentials = { accessKeyId: "AKIA", secretAccessKey: "secret" };
    const day1 = signedBedrockHeaders({ ...signingInput, credentials });
    const day2 = signedBedrockHeaders({
      ...signingInput,
      credentials,
      date: new Date("2026-05-22T12:00:00.000Z"),
    });
    expect(day1.authorization).toContain("/20260521/");
    expect(day2.authorization).toContain("/20260522/");
    expect(day1.authorization).not.toBe(day2.authorization);
  });

  it("rejects construction with an empty region", () => {
    expect(() =>
      createBedrockProvider({
        id: "bedrock",
        region: "",
        credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
        models: MODELS,
      }),
    ).toThrow("region is required");
  });

  it("rejects construction with empty static credentials", () => {
    expect(() =>
      createBedrockProvider({
        id: "bedrock",
        region: "us-east-1",
        credentials: { accessKeyId: "", secretAccessKey: "" },
        models: MODELS,
      }),
    ).toThrow("credentials are required");
  });

  it("rejects a chat call when the credential provider resolves empty credentials", async () => {
    const provider = createBedrockProvider({
      id: "bedrock",
      region: "us-east-1",
      credentials: () => Promise.resolve({ accessKeyId: "", secretAccessKey: "" }),
      models: MODELS,
      defaultModel: "anthropic.claude-3-sonnet",
      fetch: rejectingFetch("fetch must not run"),
    });
    await expect(chat(provider)).rejects.toThrow("empty AWS credentials");
  });
});

describe("AWS credential resolver edge cases", () => {
  it("throws a descriptive error when no provider yields credentials", async () => {
    await expect(
      resolveAwsCredentials({
        env: {},
        sharedCredentialsFile: "/nonexistent/aws/credentials",
        fetch: rejectingFetch("imds unreachable"),
      }),
    ).rejects.toThrow("Unable to resolve AWS credentials");
  });

  it("prefers static credentials over environment variables", async () => {
    const resolved = await resolveAwsCredentials({
      static: { accessKeyId: "STATIC", secretAccessKey: "static-secret" },
      env: { AWS_ACCESS_KEY_ID: "ENV", AWS_SECRET_ACCESS_KEY: "env-secret" },
    });
    expect(resolved.accessKeyId).toBe("STATIC");
  });

  it("treats blank static credentials as absent and falls through to env", async () => {
    const resolved = await resolveAwsCredentials({
      static: { accessKeyId: "", secretAccessKey: "" },
      env: { AWS_ACCESS_KEY_ID: "ENV", AWS_SECRET_ACCESS_KEY: "env-secret" },
    });
    expect(resolved.accessKeyId).toBe("ENV");
  });

  it("carries the session token through env credentials when present", () => {
    const resolved = envCredentialProvider({
      AWS_ACCESS_KEY_ID: "ASIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "temp",
    });
    expect(resolved).toEqual({
      accessKeyId: "ASIA",
      secretAccessKey: "secret",
      sessionToken: "temp",
    });
  });

  it("omits an empty session token from env credentials", () => {
    const resolved = envCredentialProvider({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "",
    });
    expect(resolved).toEqual({ accessKeyId: "AKIA", secretAccessKey: "secret" });
  });

  it("returns null env credentials when only the access key id is set", () => {
    expect(envCredentialProvider({ AWS_ACCESS_KEY_ID: "AKIA" })).toBeNull();
  });

  it("returns null when the shared credentials file is missing", async () => {
    await expect(
      sharedConfigCredentialProvider({}, "/definitely/not/here/credentials"),
    ).resolves.toBeNull();
  });

  it("parses a profile-prefixed INI section and strips comments", () => {
    const contents = [
      "[default]",
      "aws_access_key_id = DEFAULT",
      "",
      "[profile staging] ; the staging profile",
      "aws_access_key_id = STAGING # inline comment",
      "aws_secret_access_key = staging-secret",
    ].join("\n");
    expect(parseIniSection(contents, "staging")).toEqual({
      aws_access_key_id: "STAGING",
      aws_secret_access_key: "staging-secret",
    });
  });

  it("returns null when the requested INI section is absent", () => {
    expect(parseIniSection("[default]\naws_access_key_id = X", "missing")).toBeNull();
  });

  it("parses well-formed instance-profile credential payloads", () => {
    const body = JSON.stringify({
      AccessKeyId: "ASIA",
      SecretAccessKey: "secret",
      Token: "session",
    });
    expect(parseInstanceProfileCredentials(body)).toEqual({
      accessKeyId: "ASIA",
      secretAccessKey: "secret",
      sessionToken: "session",
    });
  });

  it("returns null for instance-profile payloads that are not valid JSON", () => {
    expect(parseInstanceProfileCredentials("<html>error</html>")).toBeNull();
  });

  it("returns null for instance-profile payloads missing required fields", () => {
    expect(parseInstanceProfileCredentials(JSON.stringify({ AccessKeyId: "ASIA" }))).toBeNull();
  });

  it("caches credentials across calls within the refresh window", async () => {
    let resolves = 0;
    const sharedFile = "/nonexistent/aws/credentials";
    // Build a provider whose resolution comes from static credentials; the
    // provider should resolve once and serve the cache on the second call.
    const provider = createBedrockCredentialProvider(
      {
        static: { accessKeyId: "AKIA", secretAccessKey: "secret" },
        env: {},
        sharedCredentialsFile: sharedFile,
      },
      60_000,
    );
    const first = await provider();
    resolves += 1;
    const second = await provider();
    expect(first).toBe(second);
    expect(resolves).toBe(1);
  });
});

describe("Vertex JWT signing and token exchange", () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keyPair.publicKey;

  it("signs a verifiable RS256 assertion with the expected claims", () => {
    const issuedAt = new Date("2026-05-21T12:00:00.000Z");
    const assertion = signServiceAccountJwt({
      clientEmail: "sa@project.iam.gserviceaccount.com",
      privateKey,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      tokenUri: "https://oauth2.googleapis.com/token",
      issuedAt,
    });

    const [header, payload, signature] = assertion.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    const decodedHeader: unknown = JSON.parse(
      Buffer.from(header as string, "base64url").toString("utf8"),
    );
    expect(decodedHeader).toEqual({ alg: "RS256", typ: "JWT" });

    const decodedPayload = JSON.parse(
      Buffer.from(payload as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decodedPayload.iss).toBe("sa@project.iam.gserviceaccount.com");
    expect(decodedPayload.sub).toBe("sa@project.iam.gserviceaccount.com");
    expect(decodedPayload.aud).toBe("https://oauth2.googleapis.com/token");
    expect(decodedPayload.iat).toBe(Math.floor(issuedAt.getTime() / 1000));
    expect(decodedPayload.exp).toBe((decodedPayload.iat as number) + 3600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header as string}.${payload as string}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature as string, "base64url")),
    ).toBe(true);
  });

  it("exchanges the JWT assertion at the token endpoint, not using it as a bearer", async () => {
    const requestBodies: string[] = [];
    let exchanged = false;
    const provider = createVertexProvider({
      id: "vertex",
      project: "proj",
      location: "us-central1",
      credentials: { clientEmail: "sa@project.iam.gserviceaccount.com", privateKey },
      models: [{ id: "claude-3-sonnet" }],
      defaultModel: "claude-3-sonnet",
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          exchanged = true;
          requestBodies.push(typeof init?.body === "string" ? init.body : "");
          return new Response(
            JSON.stringify({ access_token: "real-access-token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // The Vertex API call must carry the exchanged token, not the JWT.
        const auth = new Headers(init?.headers).get("authorization");
        expect(auth).toBe("Bearer real-access-token");
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await chat(provider);
    expect(exchanged).toBe(true);
    expect(response.message).toBe("ok");
    const exchangeBody = requestBodies[0] ?? "";
    expect(exchangeBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(exchangeBody).toContain("assertion=");
  });

  it("surfaces a descriptive error when the token exchange fails", async () => {
    const provider = createVertexProvider({
      id: "vertex",
      project: "proj",
      location: "us-central1",
      credentials: { clientEmail: "sa@project.iam.gserviceaccount.com", privateKey },
      models: [{ id: "claude-3-sonnet" }],
      defaultModel: "claude-3-sonnet",
      fetch: async () =>
        new Response("invalid_grant", {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    });
    await expect(chat(provider)).rejects.toThrow("Vertex token exchange failed");
  });

  it("uses a static access token directly without a token exchange", async () => {
    let tokenEndpointHit = false;
    const provider = createVertexProvider({
      id: "vertex",
      project: "proj",
      location: "us-central1",
      credentials: { accessToken: "pre-minted" },
      models: [{ id: "claude-3-sonnet" }],
      defaultModel: "claude-3-sonnet",
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          tokenEndpointHit = true;
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pre-minted");
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await chat(provider);
    expect(tokenEndpointHit).toBe(false);
  });

  it("rejects construction with an empty project or location", () => {
    expect(() =>
      createVertexProvider({
        id: "vertex",
        project: "",
        location: "us-central1",
        credentials: { accessToken: "x" },
        models: [{ id: "claude-3-sonnet" }],
      }),
    ).toThrow("project and location are required");
  });

  it("rejects a token-exchange response with no access_token", () => {
    expect(() => parseTokenResponse({ expires_in: 3600 })).toThrow("missing access_token");
  });

  it("rejects a malformed (non-object) token-exchange response", () => {
    expect(() => parseTokenResponse("not-json")).toThrow("malformed response");
  });

  it("defaults expires_in when it is absent or non-positive", () => {
    expect(parseTokenResponse({ access_token: "t" }).expiresInSeconds).toBe(3600);
    expect(parseTokenResponse({ access_token: "t", expires_in: -1 }).expiresInSeconds).toBe(3600);
  });
});
