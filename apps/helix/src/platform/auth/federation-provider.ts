import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import type { InferAPI } from "better-auth";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import type { BetterAuthRuntimeConfig, BetterAuthRuntime } from "./better-auth.js";

export function federationProviderPlugins(
  policy: NonNullable<BetterAuthRuntimeConfig["federationIdentity"]>,
  mutations: AsyncLocalStorage<boolean>,
): readonly [ReturnType<typeof jwt>, ReturnType<typeof oauthProvider>] {
  return [
    jwt({
      jwks: {
        keyPairConfig: { alg: "RS256" },
        rotationInterval: 30 * 24 * 3600,
        gracePeriod: 3600,
      },
    }),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth/consent",
      scopes: ["openid", "profile", "email", "offline_access"],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientPrivileges: () => mutations.getStore() === true,
      accessTokenExpiresIn: 300,
      idTokenExpiresIn: 300,
      codeExpiresIn: 300,
      postLogin: {
        page: "/login",
        consentReferenceId: () => undefined,
        shouldRedirect: ({ user, headers }) => policy.checkSession(user.id, headers),
      },
      customIdTokenClaims: async ({ user, metadata, scopes }) => ({
        ...(await policy.claims(user.id, metadata)),
        ...(scopes.includes("email")
          ? { email: user.email, email_verified: user.emailVerified }
          : {}),
        ...(scopes.includes("profile") ? { name: user.name } : {}),
      }),
      customAccessTokenClaims: ({ user, metadata }) => policy.claims(user?.id ?? "", metadata),
      customUserInfoClaims: ({ user, jwt: claims }) => policy.userInfo(user.id, claims),
    }),
  ] as const;
}

export function createFederationClientManager(
  api: InferAPI<ReturnType<typeof oauthProvider>["endpoints"]>,
  pool: Pool,
  mutations: AsyncLocalStorage<boolean>,
): NonNullable<BetterAuthRuntime["federationClients"]> {
  return {
    async discovery() {
      return api.getOpenIdConfig();
    },
    async create(input, headers) {
      return mutations.run(true, async () => {
        const metadata = { helix_org_id: input.orgId, helix_app_id: input.appId };
        const client = await api.adminCreateOAuthClient({
          headers,
          body: {
            client_name: "Helix Agentspace",
            client_uri: input.origin,
            redirect_uris: [new URL("/v1/auth/sso/callback", input.origin).href],
            scope: "openid profile email offline_access",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "client_secret_basic",
            skip_consent: true,
            require_pkce: true,
            enable_end_session: true,
            metadata,
          },
        });
        if (typeof client.client_secret !== "string")
          throw new Error("Federation client requires a confidential secret");
        await api.adminUpdateOAuthClient({
          headers,
          body: {
            client_id: client.client_id,
            update: {
              metadata: { ...metadata, helix_client_id: client.client_id },
            },
          },
        });
        return { clientId: client.client_id, clientSecret: client.client_secret };
      });
    },
    async disable(clientId) {
      await pool.query(
        'update "oauthClient" set disabled=true, "updatedAt"=now() where "clientId"=$1',
        [clientId],
      );
    },
  };
}
