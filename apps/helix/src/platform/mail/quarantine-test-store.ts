import { randomUUID } from "node:crypto";
import type { MailQuarantineStore, QuarantineInboundMailInput } from "./quarantine.js";

/** In-memory capture for ingest tests; release tests use their leased store fixture. */
export class CapturingMailQuarantineStore implements MailQuarantineStore {
  readonly records: (QuarantineInboundMailInput & { id: string })[] = [];
  async quarantine(input: QuarantineInboundMailInput) {
    const id = randomUUID();
    this.records.push({ ...input, id });
    return { id };
  }
  async listPending(orgId: string) {
    return this.records
      .filter((record) => record.orgId === orgId)
      .map((record) => ({
        id: record.id,
        recipientAddresses: record.recipientAddresses,
        envelopeFrom: record.envelopeFrom ?? null,
        signature: record.signature,
        status: "pending" as const,
        bytesDeleted: false,
        createdAt: new Date(),
        resolvedAt: null,
      }));
  }
  async claimRelease() {
    return null;
  }
  async abortRelease() {}
  async release() {
    return { resolved: false, bytesDeleted: false };
  }
  async delete() {
    return { found: false, bytesDeleted: false };
  }
}
