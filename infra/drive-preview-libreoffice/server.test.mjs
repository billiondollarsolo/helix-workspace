import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  ConversionError,
  createConversionServer,
  enforcePageLimit,
  inspectZipArchive,
  runCommand,
  validateConversionRequest,
} from "./server.mjs";

const limits = Object.freeze({
  requestBytes: 4_096,
  sourceBytes: 2_048,
  outputBytes: 1_024,
  textBytes: 1_024,
  archiveEntries: 4,
  archiveBytes: 1_024,
  archiveRatio: 20,
  cells: 3,
  pages: 2,
  timeoutMs: 1_000,
  workRoot: "/tmp",
});

test("accepts a bounded Office archive", () => {
  const source = zip([{ name: "word/document.xml", data: "<document/>" }]);
  const request = validateConversionRequest(
    "office",
    {
      name: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBase64: source.toString("base64"),
    },
    limits,
  );
  assert.equal(request.filename, "report.docx");
  assert.deepEqual(request.source, source);
});

test("rejects oversized source bytes before conversion", () => {
  assert.throws(
    () =>
      validateConversionRequest(
        "office",
        {
          name: "report.doc",
          mimeType: "application/msword",
          contentBase64: Buffer.alloc(limits.sourceBytes + 1, 1).toString("base64"),
        },
        limits,
      ),
    errorCode("source_limit_exceeded"),
  );
});

test("rejects archive entry-count, expansion, traversal, and encryption attacks", () => {
  assert.throws(
    () =>
      inspectZipArchive(
        zip(Array.from({ length: 5 }, (_, index) => ({ name: `x/${String(index)}`, data: "x" }))),
        limits,
      ),
    errorCode("unsafe_archive"),
  );
  assert.throws(
    () => inspectZipArchive(zip([{ name: "x", data: "x", expandedSize: 999 }]), limits),
    errorCode("archive_limit_exceeded"),
  );
  assert.throws(
    () => inspectZipArchive(zip([{ name: "../../escape", data: "x" }]), limits),
    errorCode("unsafe_archive"),
  );
  assert.throws(
    () => inspectZipArchive(zip([{ name: "x", data: "x", flags: 0x801 }]), limits),
    errorCode("unsafe_archive"),
  );
  assert.throws(
    () => inspectZipArchive(zip([{ name: "x", data: "x".repeat(200), expandedSize: 1 }]), limits),
    errorCode("invalid_archive"),
  );
  assert.throws(
    () =>
      validateConversionRequest(
        "text",
        {
          name: "bomb.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contentBase64: zip([
            { name: "word/document.xml", data: "x", expandedSize: 999 },
          ]).toString("base64"),
        },
        limits,
      ),
    errorCode("archive_limit_exceeded"),
  );
});

test("rejects spreadsheet cell bombs before invoking LibreOffice", () => {
  const xlsx = zip([
    {
      name: "xl/worksheets/sheet1.xml",
      data: "<worksheet><c/><c/><c/><c/></worksheet>",
    },
  ]);
  assert.throws(
    () =>
      validateConversionRequest(
        "office",
        {
          name: "bomb.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          contentBase64: xlsx.toString("base64"),
        },
        limits,
      ),
    errorCode("cell_limit_exceeded"),
  );

  const ods = zip([
    {
      name: "content.xml",
      data: '<table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="100"/></table:table-row>',
    },
  ]);
  assert.throws(
    () =>
      validateConversionRequest(
        "office",
        {
          name: "bomb.ods",
          mimeType: "application/vnd.oasis.opendocument.spreadsheet",
          contentBase64: ods.toString("base64"),
        },
        limits,
      ),
    errorCode("cell_limit_exceeded"),
  );
});

test("enforces output page bounds", () => {
  assert.doesNotThrow(() => enforcePageLimit(2, 2));
  assert.throws(() => enforcePageLimit(3, 2), errorCode("page_limit_exceeded"));
  assert.throws(() => enforcePageLimit(Number.NaN, 2), errorCode("page_limit_exceeded"));
});

test("kills a hung converter command at its deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 50,
    }),
    errorCode("conversion_timeout"),
  );
  assert.ok(Date.now() - started < 1_000);
});

test("malicious input is rejected without reaching the converter", async (context) => {
  let called = false;
  const server = createConversionServer({
    limits,
    convert: async () => {
      called = true;
      return { pdf: Buffer.from("%PDF-1.7\n"), pageCount: 1 };
    },
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const source = zip([{ name: "xl/worksheets/sheet1.xml", data: "<c/><c/><c/><c/>" }]);
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/convert/office-to-pdf`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "bomb.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentBase64: source.toString("base64"),
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "cell_limit_exceeded" });
  assert.equal(called, false);
});

test("returns only bounded text produced by the isolated converter", async (context) => {
  const server = createConversionServer({
    limits,
    convert: async () => ({ text: Buffer.from("Slide one\fSlide two"), pageCount: 2 }),
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/convert/office-to-text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      contentBase64: zip([{ name: "ppt/slides/slide1.xml", data: "<slide/>" }]).toString("base64"),
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Buffer.from(body.textBase64, "base64").toString("utf8"), "Slide one\fSlide two");
  assert.equal(body.pageCount, 2);
});

test("deployment contract is non-root, read-only, no-egress, bounded, and has no unsafe browser flags", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [dockerfile, compose, pluginCompose, helm, values, service] = await Promise.all([
    readFile(resolve(root, "infra/drive-preview-libreoffice/Dockerfile"), "utf8"),
    readFile(resolve(root, "docker-compose.yml"), "utf8"),
    readFile(resolve(root, "plugins/com.helix.drive-preview-libreoffice/compose.yaml"), "utf8"),
    readFile(resolve(root, "infra/helm/helix/templates/content-converter.yaml"), "utf8"),
    readFile(resolve(root, "infra/helm/helix/values.yaml"), "utf8"),
    readFile(resolve(root, "infra/drive-preview-libreoffice/server.mjs"), "utf8"),
  ]);
  const contract = `${dockerfile}\n${compose}\n${pluginCompose}\n${helm}\n${values}\n${service}`;

  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(pluginCompose, /read_only: true/u);
  assert.match(pluginCompose, /cap_drop:\s*\n\s*- ALL/u);
  assert.match(pluginCompose, /no-new-privileges:true/u);
  assert.match(pluginCompose, /pids_limit:/u);
  assert.match(pluginCompose, /internal: true/u);
  assert.match(
    pluginCompose,
    /DRIVE_PREVIEW_MAX_(?:BYTES|OUTPUT_BYTES|TEXT_BYTES|ARCHIVE_BYTES|CELLS|PAGES)/u,
  );
  assert.match(helm, /runAsUser: 65532/u);
  assert.match(helm, /type: RuntimeDefault/u);
  assert.match(helm, /readOnlyRootFilesystem: true/u);
  assert.match(helm, /medium: Memory/u);
  assert.match(helm, /egress: \[\]/u);
  assert.match(values, /limits:\s*\n(?:\s+.*\n)*?\s+pages: 200/u);
  assert.doesNotMatch(contract, /--no-sandbox|--disable-web-security/u);
});

test("API request paths contain no Office, image, or browser parser", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sources = await Promise.all(
    [
      "apps/helix/src/server.ts",
      "apps/helix/src/platform/drive/preview.ts",
      "apps/helix/src/platform/docs/tools.ts",
      "apps/helix/src/platform/sheets/tools.ts",
      "apps/helix/src/platform/slides/tools.ts",
    ].map((file) => readFile(resolve(root, file), "utf8")),
  );
  assert.doesNotMatch(
    sources.join("\n"),
    /(?:from\s+|import\()["'](?:mammoth|playwright|sharp|xlsx|fast-xml-parser|@jsquash\/avif)["']/u,
  );
});

function errorCode(code) {
  return (error) => error instanceof ConversionError && error.code === code;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const flags = entry.flags ?? 0x800;
    const expandedSize = entry.expandedSize ?? data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(expandedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(expandedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(local.byteLength, 16);
  return Buffer.concat([local, central, end]);
}
