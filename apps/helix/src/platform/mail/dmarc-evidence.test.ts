import { describe, expect, it } from "vitest";
import { summarizeAuthentication } from "./ingest.js";

describe("DMARC evidence without alignment", () => {
  it.each([
    ["none", undefined],
    ["temperror", "queryA ETIMEOUT example.net"],
  ])("summarizes a DMARC %s result that carries no alignment", (result, error) => {
    // mailauth omits `alignment` when the sender publishes no DMARC record or the
    // lookup fails; summarizing must not throw, or every such message is deferred.
    const auth = summarizeAuthentication({
      headers: `Authentication-Results: mx.helix.test; dmarc=${result}`,
      spf: false,
      dkim: { headerFrom: ["example.net"], envelopeFrom: "example.net", results: [] },
      dmarc: {
        domain: "example.net",
        status: { result },
        ...(error === undefined ? {} : { error }),
      },
      arc: false,
      bimi: false,
    } as unknown as Parameters<typeof summarizeAuthentication>[0]);

    expect(auth.dmarc).toBe(result);
    expect(auth.evidence).toMatchObject({ dmarc: { result, domain: "example.net" } });
    expect(JSON.stringify(auth.evidence)).not.toContain("alignment");
  });
});
