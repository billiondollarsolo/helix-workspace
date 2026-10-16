import { accountEmailFactorStatusSchema, type AccountEmailFactorStatus } from "@helix/contracts";
import { authenticatedFetch } from "@/lib/auth";
import { accountRequest } from "./api";

export async function getEmailFactorStatus(): Promise<AccountEmailFactorStatus> {
  return accountEmailFactorStatusSchema.parse(
    await accountRequest("/api/account/email-mfa", "GET", undefined, authenticatedFetch),
  );
}

export async function requestExternalEmailVerification(
  email: string,
  password: string,
): Promise<void> {
  await accountRequest(
    "/api/account/email-mfa/verification",
    "POST",
    { email, password },
    authenticatedFetch,
  );
}

export async function confirmExternalEmail(code: string): Promise<AccountEmailFactorStatus> {
  return accountEmailFactorStatusSchema.parse(
    await accountRequest(
      "/api/account/email-mfa/verification/confirm",
      "POST",
      { code },
      authenticatedFetch,
    ),
  );
}

export async function setEmailFactorEnabled(
  enabled: boolean,
  password: string,
): Promise<AccountEmailFactorStatus> {
  return accountEmailFactorStatusSchema.parse(
    await accountRequest(
      "/api/account/email-mfa/enabled",
      "POST",
      { enabled, password },
      authenticatedFetch,
    ),
  );
}
