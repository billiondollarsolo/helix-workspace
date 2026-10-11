import { HELIX_API_VERSION_PREFIX } from "../../api/version.js";

/**
 * RFC 8414 authorization-server metadata for the Helix OAuth issuer (an
 * origin). Served beneath the API prefix and, for issuer-relative discovery
 * by MCP clients (RFC 9728 → RFC 8414), at the origin root as well.
 */
export function oauthAuthorizationServerMetadata(issuerOrigin: string) {
  const issuer = new URL(issuerOrigin).origin;
  return {
    issuer,
    authorization_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/authorize`,
    token_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/token`,
    revocation_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/revoke`,
    introspection_endpoint: `${issuer}${HELIX_API_VERSION_PREFIX}/oauth/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  };
}
