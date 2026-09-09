#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (command === "capture") {
  await capture(...args);
} else if (command === "restore") {
  await restore(...args);
} else if (command === "verify") {
  await verifyLocal(...args);
} else {
  throw new Error(
    "usage: object-snapshot.mjs <capture refs.json versions.json boundary bucket endpoint output-dir|restore inventory.json bucket endpoint|verify inventory.json>",
  );
}

async function capture(refsPath, versionsPath, boundary, bucket, endpoint, outputDirectory) {
  required(refsPath, "references path");
  required(versionsPath, "versions path");
  required(boundary, "boundary");
  required(bucket, "bucket");
  required(endpoint, "endpoint");
  required(outputDirectory, "output directory");

  const rawReferences = parseArray(await readFile(refsPath, "utf8"), "database references");
  const referenceMap = new Map();
  for (const rawReference of rawReferences) {
    const reference = parseReference(rawReference);
    const existing = referenceMap.get(reference.key);
    if (
      existing &&
      ((existing.size !== null && reference.size !== null && existing.size !== reference.size) ||
        (existing.sha256 && reference.sha256 && existing.sha256 !== reference.sha256))
    ) {
      throw new Error(`conflicting database references for object: ${reference.key}`);
    }
    referenceMap.set(reference.key, {
      key: reference.key,
      size: existing?.size ?? reference.size,
      sha256: existing?.sha256 || reference.sha256,
    });
  }
  const references = [...referenceMap.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const versionDocument = parseObject(await readFile(versionsPath, "utf8"), "version inventory");
  const versions = Array.isArray(versionDocument.Versions) ? versionDocument.Versions : [];
  const boundaryMillis = Date.parse(boundary);
  if (!Number.isFinite(boundaryMillis)) throw new Error("invalid database snapshot boundary");

  const blobs = resolve(outputDirectory, "blobs");
  await mkdir(blobs, { recursive: true });
  const objects = [];

  for (const [index, reference] of references.entries()) {
    const candidates = versions
      .filter(
        (value) => value?.Key === reference.key && Date.parse(value.LastModified) <= boundaryMillis,
      )
      .sort((left, right) => Date.parse(right.LastModified) - Date.parse(left.LastModified));
    const selected = candidates[0];
    if (!selected || typeof selected.VersionId !== "string" || selected.VersionId === "null") {
      throw new Error(`no immutable version existed at the database boundary: ${reference.key}`);
    }
    if (
      !Number.isSafeInteger(selected.Size) ||
      (reference.size !== null && selected.Size !== reference.size)
    ) {
      throw new Error(`database/object size mismatch at boundary: ${reference.key}`);
    }

    const file = `blobs/${String(index).padStart(8, "0")}`;
    const destination = resolve(outputDirectory, file);
    aws(endpoint, [
      "s3api",
      "get-object",
      "--bucket",
      bucket,
      "--key",
      reference.key,
      "--version-id",
      selected.VersionId,
      destination,
    ]);
    const digest = await sha256(destination);
    if (reference.sha256 && digest !== reference.sha256) {
      throw new Error(`database/object digest mismatch at boundary: ${reference.key}`);
    }
    objects.push({
      key: reference.key,
      version_id: selected.VersionId,
      last_modified: selected.LastModified,
      etag: typeof selected.ETag === "string" ? selected.ETag : "",
      size: selected.Size,
      sha256: digest,
      file,
    });
  }

  const inventory = {
    schema_version: 1,
    bucket,
    database_boundary: new Date(boundaryMillis).toISOString(),
    object_count: objects.length,
    total_bytes: objects.reduce((sum, object) => sum + object.size, 0),
    objects,
  };
  await writeFile(
    resolve(outputDirectory, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await verifyLocal(resolve(outputDirectory, "inventory.json"));
}

async function restore(inventoryPath, targetBucket, endpoint) {
  required(inventoryPath, "inventory path");
  required(targetBucket, "target bucket");
  required(endpoint, "endpoint");
  const inventory = await readInventory(inventoryPath);
  const root = resolve(inventoryPath, "..");

  for (const object of inventory.objects) {
    aws(endpoint, [
      "s3api",
      "put-object",
      "--bucket",
      targetBucket,
      "--key",
      object.key,
      "--body",
      resolve(root, object.file),
      "--metadata",
      `helix-sha256=${object.sha256}`,
    ]);
  }

  for (const object of inventory.objects) {
    const temporary = resolve(
      tmpdir(),
      `helix-object-verify-${process.pid}-${createHash("sha256").update(object.key).digest("hex")}`,
    );
    try {
      aws(endpoint, [
        "s3api",
        "get-object",
        "--bucket",
        targetBucket,
        "--key",
        object.key,
        temporary,
      ]);
      if ((await sha256(temporary)) !== object.sha256) {
        throw new Error(`restored object digest mismatch: ${object.key}`);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function verifyLocal(inventoryPath) {
  required(inventoryPath, "inventory path");
  const inventory = await readInventory(inventoryPath);
  const root = resolve(inventoryPath, "..");
  const files = await readdir(resolve(root, "blobs")).catch(() => []);
  if (files.length !== inventory.object_count)
    throw new Error("object snapshot file count mismatch");
  for (const object of inventory.objects) {
    const path = resolve(root, object.file);
    const info = await stat(path);
    if (!info.isFile() || info.size !== object.size || (await sha256(path)) !== object.sha256) {
      throw new Error(`object snapshot verification failed: ${object.key}`);
    }
  }
}

async function readInventory(path) {
  const inventory = parseObject(await readFile(path, "utf8"), "object inventory");
  if (
    inventory.schema_version !== 1 ||
    !Number.isSafeInteger(inventory.object_count) ||
    !Array.isArray(inventory.objects)
  ) {
    throw new Error("unsupported object inventory");
  }
  const keys = new Set();
  inventory.objects = inventory.objects.map((raw) => {
    const object = parseObject(raw, "object inventory entry");
    if (
      typeof object.key !== "string" ||
      typeof object.version_id !== "string" ||
      !Number.isSafeInteger(object.size) ||
      !/^[a-f0-9]{64}$/u.test(object.sha256) ||
      !/^blobs\/\d{8}$/u.test(object.file)
    ) {
      throw new Error("invalid object inventory entry");
    }
    if (keys.has(object.key)) throw new Error(`duplicate object inventory key: ${object.key}`);
    keys.add(object.key);
    return object;
  });
  if (inventory.objects.length !== inventory.object_count)
    throw new Error("object inventory count mismatch");
  return inventory;
}

function parseReference(value) {
  const reference = parseObject(value, "database object reference");
  if (
    typeof reference.key !== "string" ||
    reference.key.length === 0 ||
    /[\0\r\n]/u.test(reference.key) ||
    (reference.size !== null && (!Number.isSafeInteger(reference.size) || reference.size < 0)) ||
    (reference.sha256 !== null &&
      reference.sha256 !== "" &&
      (typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(reference.sha256)))
  ) {
    throw new Error("invalid database object reference");
  }
  return { key: reference.key, size: reference.size, sha256: reference.sha256 || "" };
}

function aws(endpoint, args) {
  const result = spawnSync("aws", ["--no-cli-pager", "--endpoint-url", endpoint, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "aws command failed");
  return result.stdout;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArray(value, label) {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function parseObject(value, label) {
  const parsed =
    typeof value === "string" || Buffer.isBuffer(value) ? JSON.parse(value.toString()) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function required(value, label) {
  if (!value) throw new Error(`missing ${label}`);
}
