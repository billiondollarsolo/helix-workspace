import { z } from "zod";

/**
 * Domain-neutral lifecycle shared by content that must be quarantined until a
 * security scanner reaches a terminal verdict.
 */
export const SECURITY_SCAN_STATES = [
  "pending",
  "scanning",
  "clean",
  "infected",
  "scan_failed",
  "unsupported",
] as const;
export const securityScanStateSchema = z.enum(SECURITY_SCAN_STATES);
export type SecurityScanState = z.infer<typeof securityScanStateSchema>;

const scannerNameSchema = z.string().trim().min(1).max(128);
const scannerVersionSchema = z.string().trim().min(1).max(128);
const scanTimestampSchema = z.string().datetime({ offset: true });
const signatureSchema = z.string().trim().min(1).max(512);

const securityScanEvidenceShape = {
  scannerName: scannerNameSchema,
  scannerVersion: scannerVersionSchema,
  startedAt: scanTimestampSchema,
  completedAt: scanTimestampSchema,
  byteSize: z.number().int().nonnegative(),
} as const;

function completedAfterStart<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.refine(
    (value) => Date.parse(String(value.completedAt)) >= Date.parse(String(value.startedAt)),
    {
      message: "completedAt must be at or after startedAt",
      path: ["completedAt"],
    },
  );
}

const securityScanEvidenceWithoutSignatureSchema = completedAfterStart(
  z.object(securityScanEvidenceShape).strict(),
);

const infectedSecurityScanEvidenceSchema = completedAfterStart(
  z
    .object({
      ...securityScanEvidenceShape,
      signature: signatureSchema,
    })
    .strict(),
);

/**
 * Persistable, content-free scanner evidence. The enclosing result contract
 * enforces that a signature exists only for an infected verdict.
 */
export const securityScanEvidenceSchema = z.union([
  securityScanEvidenceWithoutSignatureSchema,
  infectedSecurityScanEvidenceSchema,
]);
export type SecurityScanEvidence = z.infer<typeof securityScanEvidenceSchema>;

export const securityScanResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("clean"),
      evidence: securityScanEvidenceWithoutSignatureSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("infected"),
      evidence: infectedSecurityScanEvidenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("scan_failed"),
      evidence: securityScanEvidenceWithoutSignatureSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unsupported"),
      evidence: securityScanEvidenceWithoutSignatureSchema,
    })
    .strict(),
]);
export type SecurityScanResult = z.infer<typeof securityScanResultSchema>;

/**
 * Persistable scan state, including the two non-terminal lifecycle states.
 * Pending records intentionally have no scanner evidence; scanning records
 * contain only the scanner identity, start time, and bytes observed so far.
 */
export const securityScanRecordSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({
      state: z.literal("scanning"),
      scannerName: scannerNameSchema,
      scannerVersion: scannerVersionSchema,
      startedAt: scanTimestampSchema,
      byteSize: z.number().int().nonnegative(),
    })
    .strict(),
  ...securityScanResultSchema.options,
]);
export type SecurityScanRecord = z.infer<typeof securityScanRecordSchema>;
