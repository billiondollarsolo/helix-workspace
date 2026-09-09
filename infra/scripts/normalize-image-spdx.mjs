#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SPDX_ID_PATTERN = /^SPDXRef-[A-Za-z0-9.-]+$/u;
const CREATOR_PATTERN = /^(?:Organization|Person|Tool): [^\r\n]{1,200}$/u;
const ALLOWED_TOP_LEVEL_FIELDS = Object.freeze([
  "SPDXID",
  "annotations",
  "comment",
  "creationInfo",
  "dataLicense",
  "documentDescribes",
  "documentNamespace",
  "externalDocumentRefs",
  "files",
  "hasExtractedLicensingInfos",
  "name",
  "packages",
  "relationships",
  "snippets",
  "spdxVersion",
]);

export function normalizeImageSpdx(input, { imageSubject, imageDigest }) {
  object(input, "SPDX document");
  if (
    input.spdxVersion !== "SPDX-2.3" ||
    input.dataLicense !== "CC0-1.0" ||
    input.SPDXID !== "SPDXRef-DOCUMENT"
  ) {
    throw new Error("input must be an SPDX 2.3 JSON document");
  }
  const subjectName =
    typeof imageSubject === "string" ? imageSubject.slice(imageSubject.lastIndexOf("/") + 1) : "";
  if (
    typeof imageSubject !== "string" ||
    !/^[^\s@]+$/u.test(imageSubject) ||
    subjectName.includes(":")
  ) {
    throw new Error("image subject must be a non-empty repository name without a tag or digest");
  }
  if (!DIGEST_PATTERN.test(imageDigest)) {
    throw new Error("image digest must be a sha256 OCI digest");
  }
  if (!Array.isArray(input.packages)) {
    throw new Error("SPDX document packages must be an array");
  }

  const creationInfo = normalizeCreationInfo(input.creationInfo);
  const identifiers = validateUniqueSpdxIds(input);
  const rootId = uniqueRootId(identifiers);
  const digestHex = imageDigest.slice("sha256:".length);
  const packages = globalThis.structuredClone(input.packages);
  packages.push({
    SPDXID: rootId,
    name: imageSubject,
    versionInfo: imageDigest,
    primaryPackagePurpose: "CONTAINER",
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    checksums: [{ algorithm: "SHA256", checksumValue: digestHex }],
  });

  const output = {};
  for (const field of ALLOWED_TOP_LEVEL_FIELDS) {
    if (Object.hasOwn(input, field)) output[field] = globalThis.structuredClone(input[field]);
  }
  output.spdxVersion = "SPDX-2.3";
  output.dataLicense = "CC0-1.0";
  output.SPDXID = "SPDXRef-DOCUMENT";
  output.name = `${imageSubject}@${imageDigest}`;
  output.documentNamespace =
    `https://helix.billiondollarsolo.com/spdx/` +
    `${encodeURIComponent(imageSubject)}/${digestHex}`;
  output.creationInfo = creationInfo;
  output.documentDescribes = [rootId];
  output.packages = packages;
  output.relationships = normalizeRelationships(input.relationships, rootId);

  validateUniqueSpdxIds(output);
  return output;
}

function normalizeCreationInfo(value) {
  object(value, "SPDX creationInfo");
  const created = typeof value.created === "string" ? new Date(value.created) : new Date(NaN);
  if (!Number.isFinite(created.getTime())) {
    throw new Error("SPDX creationInfo.created must be an ISO-8601 timestamp");
  }
  if (
    !Array.isArray(value.creators) ||
    value.creators.length === 0 ||
    value.creators.some((creator) => typeof creator !== "string" || !CREATOR_PATTERN.test(creator))
  ) {
    throw new Error("SPDX creationInfo.creators must contain valid SPDX creator identities");
  }
  return {
    created: created.toISOString(),
    creators: [...value.creators],
  };
}

function validateUniqueSpdxIds(document) {
  const identifiers = new Set(["SPDXRef-DOCUMENT"]);
  for (const collection of ["packages", "files", "snippets"]) {
    if (document[collection] === undefined) continue;
    if (!Array.isArray(document[collection])) {
      throw new Error(`SPDX document ${collection} must be an array`);
    }
    for (const entry of document[collection]) {
      object(entry, `SPDX ${collection} entry`);
      if (
        typeof entry.SPDXID !== "string" ||
        !SPDX_ID_PATTERN.test(entry.SPDXID) ||
        identifiers.has(entry.SPDXID)
      ) {
        throw new Error("SPDX identifiers must be valid and unique");
      }
      identifiers.add(entry.SPDXID);
    }
  }
  return identifiers;
}

function uniqueRootId(identifiers) {
  const base = "SPDXRef-ContainerImage";
  if (!identifiers.has(base)) return base;
  let suffix = 2;
  while (identifiers.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeRelationships(value, rootId) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("SPDX document relationships must be an array");
  }
  const retained = globalThis
    .structuredClone(value ?? [])
    .filter(
      (relationship) =>
        relationship?.spdxElementId !== "SPDXRef-DOCUMENT" ||
        relationship?.relationshipType !== "DESCRIBES",
    );
  retained.push({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: rootId,
  });
  return retained;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function parseArgs(argv) {
  const options = {};
  const names = new Map([
    ["--input", "input"],
    ["--output", "output"],
    ["--image-subject", "imageSubject"],
    ["--image-digest", "imageDigest"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = names.get(argv[index]);
    const value = argv[index + 1];
    if (option === undefined || value === undefined || value.length === 0) {
      throw new Error(
        "usage: normalize-image-spdx.mjs --input <path> --output <path> " +
          "--image-subject <repository> --image-digest <sha256:digest>",
      );
    }
    if (options[option] !== undefined) throw new Error(`duplicate option: ${argv[index]}`);
    options[option] = value;
  }
  for (const name of names.values()) {
    if (options[name] === undefined) throw new Error(`missing required option: ${name}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(options.input, "utf8"));
  const output = normalizeImageSpdx(input, options);
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `SPDX normalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
