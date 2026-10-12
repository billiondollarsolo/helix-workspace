import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu;
const CREDENTIALS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[0-9A-Za-z]{36}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u,
];
// AWS's published SigV4 test vector key is not a credential; only that fixture may use it.
const AWS_DOCUMENTATION_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const AWS_DOCUMENTATION_KEY_PATH = "apps/helix/src/platform/drive/s3/sigv4.test.ts";

if (process.argv.includes("--self-test")) selfTest();

if (!process.argv.includes("--self-test-only")) {
  assertCompleteHistory();
  const objects = reachableObjects();
  const blobs = batch(objects.map(({ oid }) => oid)).filter(({ type }) => type === "blob");
  const paths = new Map(objects.map(({ oid, path }) => [oid, path]));
  const reviewedKeys = reviewedHistoricalPrivateKeys();
  const findings = batch(
    blobs.map(({ oid }) => oid),
    true,
  )
    .flatMap(({ oid, body }) =>
      secretKinds(body.toString("utf8"), paths.get(oid)).map((kind) => ({
        kind,
        oid,
        path: paths.get(oid),
      })),
    )
    .filter(({ kind, oid }) => !(kind === "usable private key" && reviewedKeys.has(oid)));

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

// Private keys already reviewed in the gitleaks baseline are pinned to their exact blob:
// the same path with different content, or a key at any other path, still fails.
function reviewedHistoricalPrivateKeys() {
  const oids = new Set();
  for (const line of readFileSync(".gitleaksignore", "utf8").split("\n")) {
    const match = /^([0-9a-f]{40}):([^:]+):private-key:[1-9][0-9]*$/u.exec(line.trim());
    if (match === null) continue;
    try {
      oids.add(git(["rev-parse", "--verify", "--quiet", `${match[1]}:${match[2]}`]).trim());
    } catch {
      // A baseline entry for a commit that is not in this clone cannot excuse anything.
    }
  }
  return oids;
}

function secretKinds(source, path) {
  if (path === AWS_DOCUMENTATION_KEY_PATH) {
    source = source.replaceAll(AWS_DOCUMENTATION_KEY, "AWS_DOCUMENTATION_KEY");
  }
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
  const otherAwsKey = `AKIA${"A".repeat(16)}`;
  assert.deepEqual(secretKinds(AWS_DOCUMENTATION_KEY, AWS_DOCUMENTATION_KEY_PATH), []);
  assert.deepEqual(secretKinds(AWS_DOCUMENTATION_KEY, "other.ts"), ["provider credential"]);
  assert.deepEqual(
    secretKinds(`${AWS_DOCUMENTATION_KEY}\n${otherAwsKey}`, AWS_DOCUMENTATION_KEY_PATH),
    ["provider credential"],
  );
  assert.deepEqual(secretKinds(privateKey, AWS_DOCUMENTATION_KEY_PATH), ["usable private key"]);
  process.stdout.write("Git history secret scanner self-test passed.\n");
}
