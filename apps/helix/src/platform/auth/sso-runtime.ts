import type { SSOUserResolutionInput } from "@better-auth/sso";
import type postgres from "postgres";

const providerIdPattern =
  /^helix-oidc-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export interface TenantIdentitySecretReader {
  read(input: {
    readonly orgId: string;
    readonly scope: "idp";
    readonly handle: string;
  }): Promise<Record<string, string> | undefined>;
}

export async function resolveTenantOidcUser(
  sql: postgres.Sql,
  input: SSOUserResolutionInput,
): Promise<
  | { readonly action: "link"; readonly userId: string; readonly profile: "preserve" }
  | { readonly action: "reject"; readonly code: string; readonly message: string }
> {
  const binding = parseProviderId(input.providerId);
  if (input.protocol !== "oidc" || binding === null) return rejected("SSO_PROVIDER_NOT_ALLOWED");

  const rows = await sql.begin(async (tx) => {
    await tx`select set_config('helix.org_id', ${binding.orgId}, true)`;
    return tx<{ readonly user_id: string }[]>`
      select identity_user.id as user_id
      from tenant_idp_configs config
      join orgs organization on organization.id = config.org_id
      join admin_domains domain
        on domain.org_id = config.org_id
       and domain.domain = split_part(lower(${input.providerUser.email}), '@', 2)
       and domain.status = 'verified'
       and domain.identity_enabled
       and domain.federation_enabled
      join identity_subjects subject
        on lower(subject.canonical_email) = lower(${input.providerUser.email})
       and subject.status = 'active'
      join organization_memberships membership
        on membership.org_id = config.org_id
       and membership.subject_id = subject.id
       and membership.status = 'active'
      join actors actor
        on actor.org_id = membership.org_id
       and actor.id = membership.actor_id
       and actor.disabled_at is null
      join identity_provider_subjects link
        on link.provider = 'better-auth'
       and link.subject_id = subject.id
      join "user" identity_user on identity_user.id = link.provider_subject
      where config.id = ${binding.configId}
        and config.org_id = ${binding.orgId}
        and config.protocol = 'oidc'
        and config.enabled
        and config.is_primary
        and config.config->>'issuer' = ${input.accountKey.issuer}
        and organization.status = 'active'
        and organization.suspended_at is null
        and organization.soft_deleted_at is null
        and organization.hard_deleted_at is null
      limit 1
    `;
  });
  const userId = rows[0]?.user_id;
  return userId === undefined
    ? rejected("SSO_IDENTITY_NOT_PROVISIONED")
    : { action: "link", userId, profile: "preserve" };
}

export async function resolveTenantOidcPrivateKey(
  sql: postgres.Sql,
  secrets: TenantIdentitySecretReader | undefined,
  input: { readonly providerId: string; readonly keyId?: string; readonly issuer: string },
): Promise<{ readonly privateKeyPem: string; readonly kid?: string; readonly algorithm?: string }> {
  const binding = parseProviderId(input.providerId);
  if (binding === null || secrets === undefined)
    throw new Error("OIDC signing key is unavailable.");
  const rows = await sql.begin(async (tx) => {
    await tx`select set_config('helix.org_id', ${binding.orgId}, true)`;
    return tx<{ readonly handle: string }[]>`
      select signing_cert_secret_handle as handle
      from tenant_idp_configs
      where id = ${binding.configId}
        and org_id = ${binding.orgId}
        and protocol = 'oidc'
        and enabled
        and is_primary
        and config->>'issuer' = ${input.issuer}
        and signing_cert_secret_handle = ${input.keyId ?? ""}
      limit 1
    `;
  });
  const handle = rows[0]?.handle;
  if (handle === undefined) throw new Error("OIDC signing key binding is invalid.");
  const secret = await secrets.read({ orgId: binding.orgId, scope: "idp", handle });
  const privateKeyPem = secret?.privateKeyPem;
  if (privateKeyPem === undefined || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("OIDC signing key is unavailable.");
  }
  return {
    privateKeyPem,
    ...(secret?.kid === undefined ? {} : { kid: secret.kid }),
    ...(secret?.algorithm === undefined ? {} : { algorithm: secret.algorithm }),
  };
}

function parseProviderId(
  providerId: string,
): { readonly orgId: string; readonly configId: string } | null {
  const match = providerIdPattern.exec(providerId);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { orgId: match[1], configId: match[2] };
}

function rejected(code: string) {
  return {
    action: "reject",
    code,
    message: "SSO sign-in is not authorized for this workspace.",
  } as const;
}
