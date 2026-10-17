import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";

export function createBrowserAuthClient(fetchImpl: typeof fetch) {
  return createAuthClient({
    plugins: [twoFactorClient(), passkeyClient()],
    fetchOptions: { customFetchImpl: fetchImpl },
  });
}
