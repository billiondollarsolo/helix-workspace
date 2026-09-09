import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu;
const CREDENTIALS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[0-9A-Za-z]{36}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u,
];

if (process.argv.includes("--self-test")) selfTest();

if (!process.argv.includes("--self-test-only")) {
  assertCompleteHistory();
  const objects = reachableObjects();
  const blobs = batch(objects.map(({ oid }) => oid)).filter(({ type }) => type === "blob");
  const paths = new Map(objects.map(({ oid, path }) => [oid, path]));
  const findings = batch(
    blobs.map(({ oid }) => oid),
    true,
  ).flatMap(({ oid, body }) =>
    secretKinds(body.toString("utf8")).map((kind) => ({ kind, oid, path: paths.get(oid) })),
  );

  if (findings.length > 0) {
    for (const { kind, oid, path } of findings) {
      process.stderr.write(`${oid} ${path ?? "<unknown path>"}: ${kind}\n`);
    }
    process.stderr.write(
      `Found ${String(findings.length)} usable secret(s) in reachable Git history. Rotate them, purge the objects, and invalidate existing clones.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `No usable private key or provider credential found in ${String(blobs.length)} reachable Git blobs.\n`,
    );
  }
}

function assertCompleteHistory() {
  const shallow = git(["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow === "true") throw new Error("Git history scan requires a full clone");
}

function reachableObjects() {
  return git(["rev-list", "--objects", "--all"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0
        ? { oid: line, path: undefined }
        : { oid: line.slice(0, separator), path: line.slice(separator + 1) };
    });
}

function batch(oids, includeBody = false) {
  if (oids.length === 0) return [];
  const output = execFileSync("git", ["cat-file", includeBody ? "--batch" : "--batch-check"], {
    cwd: process.cwd(),
    input: `${oids.join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  const results = [];
  let offset = 0;
  for (const expectedOid of oids) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error(`Missing cat-file header for ${expectedOid}`);
    const [oid, type, rawSize] = output.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number(rawSize);
    if (oid !== expectedOid || !Number.isSafeInteger(size)) {
      throw new Error(`Invalid cat-file response for ${expectedOid}`);
    }
    offset = newline + 1;
    const body = includeBody ? output.subarray(offset, offset + size) : Buffer.alloc(0);
    results.push({ oid, type, body });
    if (includeBody) offset += size + 1;
  }
  return results;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function secretKinds(source) {
  const kinds = [];
  for (const match of source.matchAll(PRIVATE_KEY)) {
    try {
      createPrivateKey(match[0]);
      kinds.push("usable private key");
    } catch {
      // Documentation and seeded scanner fixtures may contain invalid PEM text.
    }
  }
  if (CREDENTIALS.some((pattern) => pattern.test(source))) kinds.push("provider credential");
  return [...new Set(kinds)];
}

function selfTest() {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  assert.deepEqual(secretKinds(privateKey), ["usable private key"]);
  const invalidPem = [
    "-----BEGIN",
    " PRIVATE KEY-----\nnot-a-key\n-----END",
    " PRIVATE KEY-----",
  ].join("");
  assert.deepEqual(secretKinds(invalidPem), []);
  assert.deepEqual(secretKinds(`token=${["ghp", "_", "a".repeat(36)].join("")}`), [
    "provider credential",
  ]);
  process.stdout.write("Git history secret scanner self-test passed.\n");
}
