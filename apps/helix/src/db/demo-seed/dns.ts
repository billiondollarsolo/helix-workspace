/**
 * The demo world's DNS, held in memory. Domain-ownership challenges and the
 * SPF, DKIM and DMARC records of every fictional sender are published here so
 * the real verifiers (domain verification, mailauth) run without the network.
 */
export class DemoDns {
  readonly #txt = new Map<string, string[][]>();

  publishTxt(name: string, value: string): void {
    const key = name.toLowerCase().replace(/\.$/u, "");
    const records = this.#txt.get(key) ?? [];
    // DNS TXT strings are at most 255 octets; longer values are split into chunks.
    const chunks: string[] = [];
    for (let start = 0; start < value.length; start += 255)
      chunks.push(value.slice(start, start + 255));
    records.push(chunks);
    this.#txt.set(key, records);
  }

  txt(name: string): readonly string[] {
    return (this.#txt.get(name.toLowerCase().replace(/\.$/u, "")) ?? []).map((chunks) =>
      chunks.join(""),
    );
  }

  /** The `resolver(name, rrtype)` contract mailauth uses for SPF, DKIM, DMARC and BIMI. */
  readonly mailauthResolver = async (name: string, rrtype: string): Promise<string[][]> => {
    const key = name.toLowerCase().replace(/\.$/u, "");
    if (rrtype === "TXT") {
      const records = this.#txt.get(key);
      if (records !== undefined) return records;
    }
    throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  };
}
