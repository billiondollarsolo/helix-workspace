import {
  type MailReceivingDomainRecord,
  type ReceivingDomainStore,
} from "./receiving-domains-store.js";
import { normalizeMailDomain } from "./address-normalization.js";

export interface SingleTenantReceivingDomainBackfillInput {
  readonly deploymentMode: string;
  readonly orgId: string;
  readonly domain: string;
  readonly createdBy: string;
  readonly catchAllActorId?: string | null;
  /** Explicit operator assertion replacing a DNS check for an existing domain. */
  readonly ownershipAttested: boolean;
}

/**
 * Explicit, idempotent legacy backfill.
 *
 * There is intentionally no "find the first org" behavior. SaaS/public mode
 * and missing operator ownership attestation fail before any store write.
 */
export async function backfillSingleTenantReceivingDomain(
  store: ReceivingDomainStore,
  input: SingleTenantReceivingDomainBackfillInput,
): Promise<MailReceivingDomainRecord> {
  if (input.deploymentMode !== "single-tenant") {
    throw new Error("Receiving-domain backfill is forbidden outside explicit single-tenant mode.");
  }
  if (!input.ownershipAttested) {
    throw new Error("Receiving-domain backfill requires an explicit ownership attestation.");
  }
  if (input.orgId.length === 0 || input.createdBy.length === 0) {
    throw new Error("Receiving-domain backfill requires exact organization and creator IDs.");
  }

  const domain = normalizeMailDomain(input.domain);
  const existing = (await store.listDomains(input.orgId)).find(
    (record) => record.domain === domain,
  );
  let record =
    existing ??
    (await store.createDomain({
      orgId: input.orgId,
      domain,
      catchAllActorId: input.catchAllActorId ?? null,
      createdBy: input.createdBy,
    }));
  /* `ownershipAttested` is checked above and stands in for the DNS challenge:
     this path exists for a domain already receiving mail before Helix tracked
     it. It is the one place a domain becomes verified without a TXT record,
     which is why it refuses to run outside explicit single-tenant mode. */
  if (record.status === "pending") {
    record = (await store.markVerified(input.orgId, record.id)) ?? missingBackfillRecord();
  }
  if (record.status === "verified" || record.status === "disabled") {
    record = (await store.enableDomain(input.orgId, record.id)) ?? missingBackfillRecord();
  }
  if (record.status !== "active") {
    throw new Error(`Receiving-domain backfill ended in unexpected ${record.status} state.`);
  }
  return record;
}

function missingBackfillRecord(): never {
  throw new Error("Receiving-domain record disappeared during backfill.");
}
