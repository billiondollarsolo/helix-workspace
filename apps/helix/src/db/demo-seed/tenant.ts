import type { JsonObject } from "@helix/sdk-types";
import { evaluateDnsRecord } from "../../platform/admin/domains.js";
import { ensureAdminDomain } from "../../platform/admin/domain-identity.js";
import { PostgresReceivingDomainStore } from "../../platform/mail/receiving-domains-store.js";
import { seedDefaultObjectStorePrefix } from "../../platform/tenancy/provisioning-storage.js";
import { COMPANY } from "./company.js";
import type { DemoDns } from "./dns.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";

export const DEMO_SEED_VERSION = 1;

export interface DemoSeedMarker extends JsonObject {
  readonly version: number;
  readonly size: string;
  readonly mode: "full" | "accounts";
  readonly state: "seeding" | "complete";
  readonly anchor: string;
}

/** The marker this seed leaves on its tenant, or null when the org is absent. */
export async function readDemoMarker(
  runtime: Pick<DemoRuntime, "orgs" | "orgId">,
): Promise<{ readonly exists: boolean; readonly marker: DemoSeedMarker | null }> {
  const org = await runtime.orgs.findById(runtime.orgId);
  if (org === null) return { exists: false, marker: null };
  const rows = await runtimeMarker(runtime as DemoRuntime);
  return { exists: true, marker: rows };
}

async function runtimeMarker(runtime: DemoRuntime): Promise<DemoSeedMarker | null> {
  const rows = await runtime.tenant(
    (tx) => tx<{ readonly marker: DemoSeedMarker | null }[]>`
      select metadata->'demoSeed' as marker from orgs where id = ${runtime.orgId}
    `,
  );
  return rows[0]?.marker ?? null;
}

export async function writeDemoMarker(runtime: DemoRuntime, marker: DemoSeedMarker): Promise<void> {
  await runtime.tenant(
    (tx) => tx`
      update orgs
      set metadata = jsonb_set(metadata, '{demoSeed}', ${tx.json(marker)}::jsonb, true)
      where id = ${runtime.orgId}
    `,
  );
}

/**
 * Creates the tenant the way a single-tenant deployment boots its default org,
 * then gives it the provisioned object-store namespace (`tenants/<org>/`) every
 * real tenant gets. All seeded bytes live under that prefix.
 */
export async function createDemoTenant(runtime: DemoRuntime): Promise<void> {
  await runtime.orgs.getOrCreateDefaultOrg({
    id: runtime.orgId,
    slug: COMPANY.slug,
    displayName: COMPANY.name,
    region: runtime.env.HELIX_REGION,
  });
  await runtime.tenant((tx) => seedDefaultObjectStorePrefix(tx, runtime.orgId));
  const resolved = await runtime.storageResolver({ orgId: runtime.orgId, refresh: true });
  if (resolved === undefined || resolved.prefix !== `tenants/${runtime.orgId}/`) {
    throw new DemoSeedError(
      "The demo tenant has no provisioned object-store namespace. Re-run with --reset so the tenant is provisioned from scratch.",
    );
  }
  await runtime.rawStorage.ensureBucket();
  await runtime.orgs.updateTenantConfig({
    orgId: runtime.orgId,
    reason: "demo-seed:tenant",
    featureFlags: {
      calendar_import_invitations: true,
      mail_outbound: true,
      drive_s3_api: true,
      assistant_retrieval: true,
    },
    branding: {
      display_name_override: COMPANY.name,
      accent_color_hex: "#2F5D8A",
      email_from_name: COMPANY.name,
    },
  });
  runtime.chronology.at(
    "orgs",
    { id: runtime.orgId },
    { created_at: runtime.timeline.start, updated_at: runtime.timeline.daysAgo(30) },
  );
}

/**
 * Registers and verifies the company domain and the local sign-in domain via
 * the same DNS-challenge path as the admin console, then turns on identity,
 * mail and alias capabilities and opens both for inbound mail.
 */
export async function verifyDemoDomains(
  runtime: DemoRuntime,
  dns: DemoDns,
  adminActorId: string,
): Promise<void> {
  const receiving = new PostgresReceivingDomainStore(runtime.sql);
  for (const domain of [COMPANY.domain, COMPANY.loginDomain]) {
    await runtime.tenant(async () => {
      const domainId = await ensureAdminDomain(runtime.sql, {
        orgId: runtime.orgId,
        domain,
        createdBy: adminActorId,
      });
      const record = await runtime.domains.getDomain(runtime.orgId, domainId);
      if (record === null) throw new DemoSeedError(`Domain ${domain} was not registered.`);
      dns.publishTxt(record.verificationHost, record.verificationValue);
      const observed = dns.txt(record.verificationHost);
      const verified = evaluateDnsRecord("TXT", record.verificationValue, observed) === "verified";
      await runtime.domains.recordDomainVerification({
        orgId: runtime.orgId,
        id: domainId,
        verified,
        actorId: adminActorId,
      });
      await runtime.domains.setDomainCapabilities({
        orgId: runtime.orgId,
        id: domainId,
        actorId: adminActorId,
        identityEnabled: true,
        mailEnabled: true,
        aliasesEnabled: true,
        customHostEnabled: false,
        federationEnabled: false,
        providerId: null,
        identityMode: "secondary",
        aliasTargetDomainId: null,
      });
      if (domain === COMPANY.domain) {
        await runtime.domains.setPrimaryDomain(runtime.orgId, domainId, adminActorId);
      }
      const capability = await receiving.createDomain({
        orgId: runtime.orgId,
        domain,
        createdBy: adminActorId,
      });
      await receiving.markVerified(runtime.orgId, capability.id);
      await receiving.enableDomain(runtime.orgId, capability.id);
      runtime.chronology.at(
        "admin_domains",
        { id: domainId },
        {
          created_at: runtime.timeline.start,
          verified_at: runtime.timeline.daysAgo(runtime.timeline.historyDays - 1, 15),
        },
      );
    }, adminActorId);
  }
}
