import { dkimVerify } from "mailauth";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { dkimDnsRecord, generateDkimKeyMaterial } from "./admin-store.js";
import { NodemailerMailTransport } from "./outbound.js";

describe("KMS-backed outbound DKIM", () => {
  it("produces an aligned signature accepted by mailauth", async () => {
    const material = generateDkimKeyMaterial(2048);
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let raw: Buffer | undefined;
    const transport = new NodemailerMailTransport(
      {
        sendMail: async (message: unknown) => {
          const result = (await stream.sendMail(message as never)) as unknown as {
            readonly message: Buffer;
          };
          raw = result.message;
          return result;
        },
      } as never,
      async () => ({
        domainName: "example.com",
        keySelector: "s1",
        privateKey: material.privateKeyPem,
      }),
    );

    await transport.send(
      {
        from: { address: "alice@example.com" },
        to: [{ address: "bob@example.net" }],
        cc: [],
        bcc: [],
        subject: "DKIM operational check",
        text: "signed",
        attachments: [],
      },
      { idempotencyKey: "delivery-1" },
    );

    expect(raw).toBeDefined();
    const result = await dkimVerify(raw ?? Buffer.alloc(0), {
      minBitLength: 2048,
      resolver: async (domain, type) => {
        expect({ domain, type }).toEqual({ domain: "s1._domainkey.example.com", type: "TXT" });
        return [[dkimDnsRecord(material.dnsPublicKey)]];
      },
    });
    expect(result.results[0]?.status.result).toBe("pass");
    expect(result.results[0]?.signingDomain).toBe("example.com");
  });
});
