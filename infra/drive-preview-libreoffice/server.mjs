import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const MiB = 1024 * 1024;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_ENTRY = 0x02014b50;
const ZIP_LOCAL_ENTRY = 0x04034b50;
const ZIP_OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
  ".pptx",
  ".pptm",
  ".ppsx",
  ".ppsm",
  ".potx",
  ".potm",
  ".odt",
  ".ott",
  ".ods",
  ".ots",
  ".odp",
  ".otp",
]);
const XML_SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xltx", ".xltm", ".ods", ".ots"]);

export class ConversionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ConversionError";
    this.status = status;
    this.code = code;
  }
}

export function limitsFromEnv(source = process.env) {
  return Object.freeze({
    requestBytes: boundedInt(source.DRIVE_PREVIEW_REQUEST_BYTES, 70 * MiB, 1, 140 * MiB),
    sourceBytes: boundedInt(source.DRIVE_PREVIEW_MAX_BYTES, 50 * MiB, 1, 100 * MiB),
    outputBytes: boundedInt(source.DRIVE_PREVIEW_MAX_OUTPUT_BYTES, 64 * MiB, 1, 128 * MiB),
    textBytes: boundedInt(source.DRIVE_PREVIEW_MAX_TEXT_BYTES, 10 * MiB, 1, 20 * MiB),
    archiveEntries: boundedInt(source.DRIVE_PREVIEW_MAX_ARCHIVE_ENTRIES, 2_048, 1, 4_096),
    archiveBytes: boundedInt(source.DRIVE_PREVIEW_MAX_ARCHIVE_BYTES, 256 * MiB, 1, 512 * MiB),
    archiveRatio: boundedInt(source.DRIVE_PREVIEW_MAX_ARCHIVE_RATIO, 100, 1, 200),
    cells: boundedInt(source.DRIVE_PREVIEW_MAX_CELLS, 1_000_000, 1, 2_000_000),
    pages: boundedInt(source.DRIVE_PREVIEW_MAX_PAGES, 200, 1, 500),
    timeoutMs: boundedInt(source.DRIVE_PREVIEW_TIMEOUT_MS, 30_000, 1_000, 60_000),
    workRoot: source.DRIVE_PREVIEW_WORKDIR || tmpdir(),
  });
}

export function createConversionServer(options = {}) {
  const limits = options.limits ?? limitsFromEnv();
  const convert = options.convert ?? convertWithLibreOffice;
  let active = false;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/healthz" || request.url === "/readyz")) {
        writeJson(response, 200, { ok: true, busy: active });
        return;
      }
      const kind = conversionKind(request.method, request.url);
      if (kind === null) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new ConversionError(415, "unsupported_media_type", "JSON is required.");
      }
      if (active) {
        throw new ConversionError(503, "converter_busy", "The converter is busy.");
      }
      active = true;
      try {
        const body = await readJsonBody(request, limits.requestBytes);
        const conversion = validateConversionRequest(kind, body, limits);
        const controller = new AbortController();
        request.once("aborted", () =>
          controller.abort(new ConversionError(499, "request_aborted", "Request aborted.")),
        );
        const deadline = setTimeout(
          () =>
            controller.abort(
              new ConversionError(504, "conversion_timeout", "Conversion timed out."),
            ),
          limits.timeoutMs,
        );
        let result;
        try {
          result = await convert(conversion, limits, controller.signal);
        } finally {
          clearTimeout(deadline);
        }
        enforcePageLimit(result.pageCount, limits.pages);
        if (conversion.kind === "text") {
          if (
            !Buffer.isBuffer(result.text) ||
            result.text.byteLength === 0 ||
            result.text.byteLength > limits.textBytes
          ) {
            throw new ConversionError(422, "invalid_output", "Converter output is invalid.");
          }
          writeJson(response, 200, {
            textBase64: result.text.toString("base64"),
            pageCount: result.pageCount,
            generatedAt: new Date().toISOString(),
          });
        } else {
          if (
            !Buffer.isBuffer(result.pdf) ||
            result.pdf.byteLength < 5 ||
            result.pdf.byteLength > limits.outputBytes ||
            !result.pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))
          ) {
            throw new ConversionError(422, "invalid_output", "Converter output is invalid.");
          }
          writeJson(response, 200, {
            pdfBase64: result.pdf.toString("base64"),
            pageCount: result.pageCount,
            generatedAt: new Date().toISOString(),
          });
        }
      } finally {
        active = false;
      }
    } catch (error) {
      const failure = publicFailure(error);
      writeJson(response, failure.status, { error: failure.code });
    }
  });
  server.requestTimeout = limits.timeoutMs + 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function validateConversionRequest(kind, value, limits) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.contentBase64 !== "string"
  ) {
    throw new ConversionError(400, "invalid_request", "Invalid conversion request.");
  }
  const source = decodeBoundedBase64(value.contentBase64, limits.sourceBytes);
  const extension = kind === "html" ? ".html" : path.extname(value.name).toLowerCase();
  if (kind === "html") {
    if (value.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
      throw new ConversionError(415, "unsupported_format", "HTML input is required.");
    }
  } else if (!ZIP_OFFICE_EXTENSIONS.has(extension)) {
    throw new ConversionError(415, "unsupported_format", "Unsupported Office format.");
  }

  let archiveEntries = [];
  if (kind !== "html" && ZIP_OFFICE_EXTENSIONS.has(extension)) {
    archiveEntries = inspectZipArchive(source, limits);
  }
  if (XML_SPREADSHEET_EXTENSIONS.has(extension)) {
    enforceSpreadsheetCellLimit(source, archiveEntries, extension, limits);
  }
  return {
    kind,
    source,
    filename: safeFilename(value.name, extension),
  };
}

export function inspectZipArchive(bytes, limits) {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0 || bytes.readUInt32LE(eocdOffset) !== ZIP_EOCD) {
    throw new ConversionError(422, "invalid_archive", "ZIP directory is missing.");
  }
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength !== bytes.byteLength ||
    centralOffset + centralSize !== eocdOffset ||
    entryCount > limits.archiveEntries
  ) {
    throw new ConversionError(422, "unsafe_archive", "ZIP structure exceeds policy.");
  }

  const entries = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_ENTRY) {
      throw new ConversionError(422, "invalid_archive", "Invalid ZIP central entry.");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      end > eocdOffset ||
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new ConversionError(422, "unsafe_archive", "Unsupported ZIP entry.");
    }
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    if (unsafeArchivePath(name)) {
      throw new ConversionError(422, "unsafe_archive", "Unsafe ZIP path.");
    }
    validateLocalZipEntry(bytes, {
      name,
      flags,
      method,
      compressedSize,
      expandedSize,
      localOffset,
    });
    expandedBytes += expandedSize;
    const ratio = expandedSize / Math.max(1, compressedSize);
    if (
      expandedBytes > limits.archiveBytes ||
      expandedSize > limits.archiveBytes ||
      ratio > limits.archiveRatio
    ) {
      throw new ConversionError(413, "archive_limit_exceeded", "ZIP expansion exceeds policy.");
    }
    const entry = { name, flags, method, compressedSize, expandedSize, localOffset };
    readZipEntry(bytes, entry, Math.min(limits.archiveBytes, Math.max(1, expandedSize + 1)));
    entries.push(entry);
    offset = end;
  }
  if (offset !== eocdOffset) {
    throw new ConversionError(422, "invalid_archive", "Unexpected ZIP directory data.");
  }
  return entries;
}

function validateLocalZipEntry(bytes, entry) {
  if (
    entry.localOffset + 30 > bytes.byteLength ||
    bytes.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_ENTRY
  ) {
    throw new ConversionError(422, "invalid_archive", "Invalid ZIP local entry.");
  }
  const flags = bytes.readUInt16LE(entry.localOffset + 6);
  const method = bytes.readUInt16LE(entry.localOffset + 8);
  const compressedSize = bytes.readUInt32LE(entry.localOffset + 18);
  const expandedSize = bytes.readUInt32LE(entry.localOffset + 22);
  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30;
  const end = start + nameLength + extraLength + entry.compressedSize;
  const name = bytes
    .subarray(start, start + nameLength)
    .toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
  if (
    end > bytes.byteLength ||
    flags !== entry.flags ||
    method !== entry.method ||
    name !== entry.name ||
    ((flags & 8) === 0 &&
      (compressedSize !== entry.compressedSize || expandedSize !== entry.expandedSize))
  ) {
    throw new ConversionError(422, "invalid_archive", "ZIP headers are inconsistent.");
  }
}

export function enforcePageLimit(pageCount, maximum) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > maximum) {
    throw new ConversionError(413, "page_limit_exceeded", "PDF page count exceeds policy.");
  }
}

export async function runCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let forcedError;
    const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-65_536);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const kill = (error) => {
      if (forcedError !== undefined) return;
      forcedError = error;
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => kill(new ConversionError(504, "conversion_timeout", "Conversion timed out.")),
      options.timeoutMs,
    );
    const onAbort = () =>
      kill(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new ConversionError(499, "request_aborted", "Request aborted."),
      );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (forcedError !== undefined) reject(forcedError);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${executable} exited with code ${String(code)}.`));
    });
  });
}

async function convertWithLibreOffice(input, limits, signal) {
  await mkdir(limits.workRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(limits.workRoot, "job-"));
  try {
    const inputPath = path.join(workDir, input.filename);
    await writeFile(inputPath, input.source, { mode: 0o600 });
    const env = {
      HOME: workDir,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TMPDIR: workDir,
    };
    await runCommand(
      "libreoffice",
      [
        "--headless",
        "--safe-mode",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--norestore",
        `-env:UserInstallation=${pathToFileURL(path.join(workDir, "profile")).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        workDir,
        inputPath,
      ],
      { cwd: workDir, env, timeoutMs: limits.timeoutMs, signal },
    );
    const pdfPath = path.join(workDir, `${path.parse(inputPath).name}.pdf`);
    const pdfStats = await stat(pdfPath);
    if (pdfStats.size < 5 || pdfStats.size > limits.outputBytes) {
      throw new ConversionError(413, "output_limit_exceeded", "PDF output exceeds policy.");
    }
    const info = await runCommand("pdfinfo", [pdfPath], {
      cwd: workDir,
      env,
      timeoutMs: Math.min(5_000, limits.timeoutMs),
      signal,
    });
    const pageCount = Number(/^Pages:\s+(\d+)$/mu.exec(info.stdout)?.[1]);
    enforcePageLimit(pageCount, limits.pages);
    if (input.kind === "text") {
      const textPath = path.join(workDir, "extracted.txt");
      await runCommand("pdftotext", ["-layout", pdfPath, textPath], {
        cwd: workDir,
        env,
        timeoutMs: limits.timeoutMs,
        signal,
      });
      const textStats = await stat(textPath);
      if (textStats.size === 0 || textStats.size > limits.textBytes) {
        throw new ConversionError(413, "output_limit_exceeded", "Text output exceeds policy.");
      }
      return { text: await readFile(textPath), pageCount };
    }
    const pdf = await readFile(pdfPath);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new ConversionError(422, "invalid_output", "Converter output is not a PDF.");
    }
    return { pdf, pageCount };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function enforceSpreadsheetCellLimit(source, entries, extension, limits) {
  const targets = entries.filter((entry) =>
    extension === ".ods" || extension === ".ots"
      ? entry.name === "content.xml"
      : /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.name),
  );
  if (targets.length === 0) {
    throw new ConversionError(422, "invalid_archive", "Spreadsheet XML is missing.");
  }
  let cells = 0;
  for (const entry of targets) {
    const xml = readZipEntry(source, entry, limits.archiveBytes).toString("utf8");
    if (/encoding\s*=\s*["']utf-(?:16|32)/iu.test(xml) || /<!DOCTYPE|<!ENTITY/iu.test(xml)) {
      throw new ConversionError(422, "unsafe_xml", "Spreadsheet XML is unsafe.");
    }
    cells +=
      extension === ".ods" || extension === ".ots"
        ? countOdsCells(xml, limits.cells - cells)
        : countXlsxCells(xml, limits.cells - cells);
    if (cells > limits.cells) {
      throw new ConversionError(
        413,
        "cell_limit_exceeded",
        "Spreadsheet cell count exceeds policy.",
      );
    }
  }
}

function countXlsxCells(xml, remaining) {
  let count = 0;
  const cell = /<(?:[A-Za-z_][\w.-]*:)?c(?:\s|\/?>)/gu;
  while (cell.exec(xml) !== null) {
    count += 1;
    if (count > remaining) break;
  }
  return count;
}

function countOdsCells(xml, remaining) {
  let total = 0;
  let rowCells = 0;
  let rowRepeat = 1;
  const token = /<(\/)?(?:[A-Za-z_][\w.-]*:)?(table-row|table-cell|covered-table-cell)\b[^>]*>/gu;
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    const value = match[0];
    if (match[1] === "/") {
      total += rowCells * rowRepeat;
      rowCells = 0;
      rowRepeat = 1;
    } else if (match[2] === "table-row") {
      rowRepeat = repeatedCount(value, "number-rows-repeated", remaining + 1);
    } else {
      rowCells += repeatedCount(value, "number-columns-repeated", remaining + 1);
    }
    if (total + rowCells * rowRepeat > remaining) return remaining + 1;
  }
  return total + rowCells * rowRepeat;
}

function repeatedCount(tag, attribute, cap) {
  const match = new RegExp(`(?:[A-Za-z_][\\w.-]*:)?${attribute}=["'](\\d+)["']`, "u").exec(tag);
  if (match === null) return 1;
  const value = BigInt(match[1]);
  return value > BigInt(cap) ? cap + 1 : Number(value);
}

function readZipEntry(bytes, entry, maxOutputLength) {
  if (
    entry.localOffset + 30 > bytes.byteLength ||
    bytes.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_ENTRY
  ) {
    throw new ConversionError(422, "invalid_archive", "Invalid ZIP local entry.");
  }
  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) {
    throw new ConversionError(422, "invalid_archive", "Truncated ZIP entry.");
  }
  const compressed = bytes.subarray(start, end);
  let expanded;
  try {
    expanded = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength });
  } catch {
    throw new ConversionError(422, "invalid_archive", "ZIP entry data is invalid.");
  }
  if (expanded.byteLength !== entry.expandedSize) {
    throw new ConversionError(422, "invalid_archive", "ZIP entry size is inconsistent.");
  }
  return expanded;
}

function findEndOfCentralDirectory(bytes) {
  const first = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD) return offset;
  }
  return -1;
}

function unsafeArchivePath(name) {
  return (
    name.length === 0 ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:/u.test(name) ||
    name.split(/[\\/]/u).includes("..")
  );
}

function decodeBoundedBase64(value, maximum) {
  if (
    value.length === 0 ||
    value.length > Math.ceil((maximum * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new ConversionError(400, "invalid_content", "Content encoding is invalid.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new ConversionError(413, "source_limit_exceeded", "Source bytes exceed policy.");
  }
  return bytes;
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk) => {
      if (failed) return;
      size += chunk.byteLength;
      if (size > limit) {
        failed = true;
        reject(new ConversionError(413, "request_limit_exceeded", "Request body exceeds policy."));
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        reject(new ConversionError(400, "invalid_json", "Request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function conversionKind(method, url) {
  if (method !== "POST") return null;
  if (url === "/convert/office-to-pdf") return "office";
  if (url === "/convert/html-to-pdf") return "html";
  if (url === "/convert/office-to-text") return "text";
  return null;
}

function safeFilename(name, extension) {
  const stem = path
    .basename(name, path.extname(name))
    .replace(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, 120);
  return `${stem || "document"}${extension}`;
}

function boundedInt(raw, fallback, minimum, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Conversion limit must be an integer from ${String(minimum)} to ${String(maximum)}.`,
    );
  }
  return value;
}

function publicFailure(error) {
  if (error instanceof ConversionError) return error;
  return { status: 500, code: "conversion_failed" };
}

function writeJson(response, status, body) {
  if (response.destroyed || response.headersSent) return;
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(payload.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const limits = limitsFromEnv();
  const port = boundedInt(process.env.PORT, 8080, 1, 65_535);
  const host = process.env.HOST || "0.0.0.0";
  createConversionServer({ limits }).listen(port, host, () => {
    console.log(`helix content converter listening on ${host}:${String(port)}`);
  });
}
