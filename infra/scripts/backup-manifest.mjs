#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const [command, rootArg, manifestArg, keyArg, expectedVersion = ""] = process.argv.slice(2);
if (!command || !rootArg || !manifestArg || !keyArg || !["sign", "verify"].includes(command)) {
  throw new Error(
    "usage: backup-manifest.mjs <sign|verify> <backup-root> <manifest.json> <key.pem> [expected-app-version]",
  );
}

const root = resolve(rootArg);
const manifestPath = containedPath(root, manifestArg);
const signaturePath = resolve(root, "manifest.sig");

if (command === "sign") {
  await createSignedManifest(root, manifestPath, signaturePath, keyArg);
} else {
  await verifySignedManifest(root, manifestPath, signaturePath, keyArg, expectedVersion);
}

async function createSignedManifest(rootPath, targetManifest, targetSignature, privateKeyPath) {
  const manifest = parseObject(await readFile(targetManifest, "utf8"), "manifest");
  const files = await inventory(rootPath);
  manifest.integrity = {
    algorithm: "sha256",
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdentity(publicKey);
  const signature = sign(null, bytes, privateKey).toString("base64");

  await writeFile(targetManifest, bytes, { mode: 0o600 });
  await writeFile(
    targetSignature,
    `${JSON.stringify({ algorithm: "Ed25519", key_id: keyId, signature }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function verifySignedManifest(
  rootPath,
  targetManifest,
  targetSignature,
  publicKeyPath,
  expectedAppVersion,
) {
  const [manifestBytes, signatureDocument, publicKeyBytes] = await Promise.all([
    readFile(targetManifest),
    readFile(targetSignature, "utf8"),
    readFile(publicKeyPath),
  ]);
  const signature = parseObject(signatureDocument, "manifest signature");
  if (
    signature.algorithm !== "Ed25519" ||
    typeof signature.key_id !== "string" ||
    typeof signature.signature !== "string"
  ) {
    throw new Error("invalid manifest signature document");
  }
  const publicKey = createPublicKey(publicKeyBytes);
  if (signature.key_id !== keyIdentity(publicKey)) {
    throw new Error("manifest signing key identity mismatch");
  }
  if (!verify(null, manifestBytes, publicKey, Buffer.from(signature.signature, "base64"))) {
    throw new Error("manifest signature verification failed");
  }

  const manifest = parseObject(manifestBytes.toString("utf8"), "manifest");
  if (
    manifest.schema_version !== 3 ||
    typeof manifest.app_version !== "string" ||
    manifest.app_version.length === 0
  ) {
    throw new Error("backup manifest schema or application version is unsupported");
  }
  const postgres = parseObject(manifest.postgres, "manifest postgres metadata");
  if (
    typeof postgres.end_lsn !== "string" ||
    postgres.end_lsn.length === 0 ||
    !Array.isArray(postgres.migrations)
  ) {
    throw new Error("backup manifest database metadata is incomplete");
  }
  if (expectedAppVersion && manifest.app_version !== expectedAppVersion) {
    throw new Error("backup application version does not match the required restore version");
  }
  const integrity = parseObject(manifest.integrity, "manifest integrity");
  if (integrity.algorithm !== "sha256" || !Array.isArray(integrity.files)) {
    throw new Error("manifest integrity inventory is invalid");
  }
  const expected = integrity.files.map(parseFileEntry);
  const actual = await inventory(rootPath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("backup contents do not match the signed manifest");
  }
  if (
    integrity.file_count !== actual.length ||
    integrity.total_bytes !== actual.reduce((total, file) => total + file.size, 0)
  ) {
    throw new Error("backup manifest counts do not match its inventory");
  }
}

async function inventory(rootPath) {
  const files = [];
  await walk(rootPath, rootPath, files);
  return files
    .filter((file) => file.path !== "manifest.json" && file.path !== "manifest.sig")
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(rootPath, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const relativePath = canonicalRelativePath(rootPath, path);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`backup contains a symbolic link: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      await walk(rootPath, path, files);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`backup contains an unsupported filesystem entry: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      size: stats.size,
      sha256: await sha256File(path),
    });
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function keyIdentity(publicKey) {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function containedPath(rootPath, path) {
  const candidate = resolve(path);
  canonicalRelativePath(rootPath, candidate);
  return candidate;
}

function canonicalRelativePath(rootPath, path) {
  const value = relative(rootPath, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || value.includes("\0")) {
    throw new Error("manifest path escapes the backup root");
  }
  return value.split(sep).join("/");
}

function parseObject(value, label) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseFileEntry(value) {
  const entry = parseObject(value, "manifest file entry");
  if (
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256)
  ) {
    throw new Error("manifest file entry is invalid");
  }
  return { path: entry.path, size: entry.size, sha256: entry.sha256 };
}
