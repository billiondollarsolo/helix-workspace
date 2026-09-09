import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { MailRawSourceIntegrityError } from "./errors.js";
import {
  MAIL_RAW_SOURCE_MAX_BYTES,
  MAIL_RAW_PARSER,
  prepareMailRawSource,
  projectParsedMail,
  verifyMailRawSource,
} from "./raw-source.js";

const raw = Buffer.from(
  [
    "From: Ada <ada@example.net>",
    "To: Alice <alice@example.com>",
    "Subject: Evidence",
    "Message-ID: <evidence@example.net>",
    "DKIM-Signature: v=1; d=example.net; s=mail; b=private-signature-value",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="alternative"',
    "",
    "--alternative",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain alternative.",
    "--alternative",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML alternative.</p>",
    "--alternative--",
    "--outer",
    "Content-Type: image/png",
    'Content-Disposition: inline; filename="logo.png"',
    "Content-ID: <logo@example.net>",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--outer",
    "Content-Type: application/pkcs7-signature",
    'Content-Disposition: attachment; filename="smime.p7s"',
    "Content-Transfer-Encoding: base64",
    "",
    "BAUG",
    "--outer--",
    "",
  ].join("\r\n"),
);

describe("raw mail evidence", () => {
  it("pins the projection parser to the installed dependency", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { readonly dependencies: { readonly mailparser: string } };
    expect(MAIL_RAW_PARSER).toBe(`mailparser@${packageJson.dependencies.mailparser}`);
  });

  it("projects MIME structure without retaining executable or secret values", async () => {
    const projection = projectParsedMail(await simpleParser(raw));
    const encoded = JSON.stringify(projection);
    const attachments = projection.attachments as readonly Record<string, unknown>[];

    expect(projection).toMatchObject({
      version: 1,
      parser: "mailparser@3.9.20",
      bodies: { text: expect.any(Object), html: expect.any(Object) },
    });
    expect(attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "image/png",
          disposition: "inline",
          contentId: "<logo@example.net>",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({ contentType: "application/pkcs7-signature" }),
      ]),
    );
    expect(encoded).not.toContain("private-signature-value");
    expect(encoded).not.toContain("<p>HTML alternative.</p>");
  });

  it("verifies byte identity and deterministic reparsing", async () => {
    const source = prepareMailRawSource(raw, await simpleParser(raw));

    await expect(verifyMailRawSource(source)).resolves.toBeUndefined();
    expect(source.bytes).toEqual(raw);
    expect(source.byteSize).toBe(raw.byteLength);

    const reorderedProjection = {
      attachments: source.projection.attachments ?? null,
      bodies: source.projection.bodies ?? null,
      headers: source.projection.headers ?? null,
      version: source.projection.version ?? null,
      parser: source.projection.parser ?? null,
    };
    await expect(
      verifyMailRawSource({
        ...source,
        projection: JSON.parse(JSON.stringify(reorderedProjection)) as typeof source.projection,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed for mutated bytes, projections, and unknown versions", async () => {
    const source = prepareMailRawSource(raw, await simpleParser(raw));
    const mutated = Buffer.from(source.bytes);
    mutated[mutated.byteLength - 5] = mutated[mutated.byteLength - 5] === 65 ? 66 : 65;

    await expect(verifyMailRawSource({ ...source, bytes: mutated })).rejects.toBeInstanceOf(
      MailRawSourceIntegrityError,
    );
    await expect(
      verifyMailRawSource({ ...source, projection: { ...source.projection, version: 2 } }),
    ).rejects.toBeInstanceOf(MailRawSourceIntegrityError);
    await expect(verifyMailRawSource({ ...source, projectionVersion: 2 })).rejects.toBeInstanceOf(
      MailRawSourceIntegrityError,
    );
  });

  it("rejects evidence larger than the fixed ingest bound", async () => {
    const oversized = Buffer.alloc(MAIL_RAW_SOURCE_MAX_BYTES + 1);
    expect(() =>
      prepareMailRawSource(oversized, {
        attachments: [],
        headers: new Map(),
        headerLines: [],
        html: false,
      }),
    ).toThrow(RangeError);
  });
});
