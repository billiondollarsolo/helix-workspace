import type { JsonObject } from "@helix/sdk-types";
import type { AuthenticateResult } from "mailauth";
import { compactJsonObject } from "../util/json.js";

/**
 * mailauth omits `alignment` (despite its type) when the sender publishes no DMARC
 * record or the lookup fails, so absent alignment is evidence of nothing, not an error.
 */
export function dmarcAlignmentEvidence(
  dmarc: Exclude<AuthenticateResult["dmarc"], false>,
): JsonObject | undefined {
  const alignment = (dmarc as Partial<typeof dmarc>).alignment;
  if (alignment === undefined) return undefined;
  return compactJsonObject({
    spf: compactJsonObject({
      result: alignment.spf.result ?? null,
      strict: alignment.spf.strict,
    }),
    dkim: compactJsonObject({
      result: alignment.dkim.result ?? null,
      strict: alignment.dkim.strict,
      underSized: alignment.dkim.underSized,
    }),
  });
}
