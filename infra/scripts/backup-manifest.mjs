#!/usr/bin/env node
import {
  createHash,
  createHmac,
  timingSafeEqual,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const BACKUP_MANIFEST_SCHEMA = "helix.backup-manifest.v3";
const MANIFEST_NAME = "manifest.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const PRODUCTION_TIERS = new Set(["business", "enterprise", "sovereign"]);
const MINIMUM_RETENTION_DAYS = { personal: 0, business: 30, enterprise: 90, sovereign: 365 };
const OPTION_KEYS_BY_FLAG = {
  "--root": "root",
  "--backup-id": "backupId",
  "--tier": "tier",
  "--created-at": "createdAt",
  "--database-captured-at": "databaseCapturedAt",
  "--objects-captured-at": "objectsCapturedAt",
  "--database-mode": "databaseMode",
  "--objects-included": "objectsIncluded",
  "--object-bucket": "objectBucket",
  "--object-versioning": "objectVersioning",
  "--object-replication": "objectReplication",
  "--encryption": "encryption",
  "--key-custody-ref": "keyCustodyRef",
  "--off-host-uri": "offHostUri",
  "--retention-days": "retentionDays",
};

const usage = `Usage:
  infra/scripts/backup-manifest.mjs create --root <dir> [options]
  infra/scripts/backup-manifest.mjs verify --root <dir> [--json]
  infra/scripts/backup-manifest.mjs object-samples --root <dir>

Create options:
  --backup-id <id>
  --tier <personal|business|enterprise|sovereign>
  --created-at <ISO-8601>
  --database-captured-at <ISO-8601>
  --objects-captured-at <ISO-8601>
  --database-mode <logical-dump|physical-basebackup>
  --objects-included <true|false>
  --object-bucket <name>
  --object-versioning <Enabled|Suspended|Unavailable>
  --object-replication <configured|not-configured|not-applicable>
  --encryption <none|age|kms>
  --key-custody-ref <non-secret reference>
  --off-host-uri <s3://bucket/prefix>
  --retention-days <positive integer>
`;

if (isMain()) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "sign" || (args[0] === "verify" && args[1] !== "--root")) {
      const [command, rootArg, manifestArg, keyArg, expectedVersion = ""] = args;
      if (!rootArg || !manifestArg || !keyArg || args.length > 5) {
        throw new Error(
          "usage: backup-manifest.mjs <sign|verify> <backup-root> <manifest.json> <key.pem> [expected-app-version]",
        );
      }
      const root = resolve(rootArg);
      const manifestPath = containedPath(root, manifestArg);
      const signaturePath = resolve(root, "manifest.sig");
      if (command === "sign") await createSignedManifest(root, manifestPath, signaturePath, keyArg);
      else await verifySignedManifest(root, manifestPath, signaturePath, keyArg, expectedVersion);
    } else {
      const { command, options } = parseCli(args);
      if (command === "create") {
        const manifest = await createBackupManifest(options.root, options);
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      } else if (command === "verify") {
        const result = await verifyBackupManifest(options.root);
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : `backup manifest verified: ${result.backupId} (${String(result.artifactCount)} artifacts)\n`,
        );
      } else if (command === "object-samples") {
        const manifest = await readVerifiedManifest(options.root);
        const prefix = `objects/${manifest.objects.bucket}/`;
        for (const sample of manifest.objects.sampledCorpus) {
          if (!sample.path.startsWith(prefix))
            throw new Error("object sample path is outside bucket");
          process.stdout.write(`${sample.sha256}\t${sample.path.slice(prefix.length)}\n`);
        }
      } else {
        process.stdout.write(usage);
      }
    }
  } catch (error) {
    process.stderr.write(
      `backup manifest failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export async function createBackupManifest(root, rawOptions) {
  const options = normalizeCreateOptions(rawOptions);
  const artifacts = await collectArtifacts(root);
  requireArtifact(artifacts, "consistency/database.tsv");
  if (options.databaseMode === "logical-dump") {
    requireArtifact(artifacts, "postgres.dump");
  } else {
    requireArtifactPrefix(artifacts, "postgres-basebackup/");
  }
  if (options.objectsIncluded) {
    requireArtifactPrefix(artifacts, `objects/${options.objectBucket}/`);
    requireArtifact(artifacts, `objects/${options.objectBucket}.versions.json`);
  }

  const databaseTime = Date.parse(options.databaseCapturedAt);
  const objectsTime = Date.parse(options.objectsCapturedAt);
  const protectedManifest = {
    schema: BACKUP_MANIFEST_SCHEMA,
    backupId: options.backupId,
    createdAt: options.createdAt,
    tier: options.tier,
    recoverySet: {
      databaseCapturedAt: options.databaseCapturedAt,
      objectsCapturedAt: options.objectsCapturedAt,
      maximumCaptureSkewSeconds: Math.round(Math.abs(databaseTime - objectsTime) / 1000),
    },
    database: {
      mode: options.databaseMode,
      consistencyArtifact: "consistency/database.tsv",
    },
    objects: {
      included: options.objectsIncluded,
      bucket: options.objectBucket,
      versioning: options.objectVersioning,
      replication: options.objectReplication,
      versionInventoryArtifact: options.objectsIncluded
        ? `objects/${options.objectBucket}.versions.json`
        : null,
      sampledCorpus: artifacts
        .filter(({ path }) => path.startsWith(`objects/${options.objectBucket}/`))
        .slice(0, 25)
        .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    },
    encryption: {
      method: options.encryption,
      keyCustodyRef: options.keyCustodyRef,
      plaintextKeyMaterialIncluded: false,
    },
    resilience: {
      offHostUri: options.offHostUri,
      retentionDays: options.retentionDays,
      versioningRequired: PRODUCTION_TIERS.has(options.tier),
      replicationRequired: PRODUCTION_TIERS.has(options.tier),
    },
    artifacts,
  };
  const manifestWithoutMac = {
    ...protectedManifest,
    recoverySet: {
      id: createHash("sha256").update(recoverySetMaterial(protectedManifest)).digest("hex"),
      ...protectedManifest.recoverySet,
    },
    integrity: {
      algorithm: "hmac-sha256",
      keyRef: options.integrityKeyRef,
    },
  };
  const manifest = {
    ...manifestWithoutMac,
    integrity: {
      ...manifestWithoutMac.integrity,
      mac: createManifestMac(manifestWithoutMac, options.integrityKey),
    },
  };
  validateManifestShape(manifest);
  await writeFile(resolve(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyBackupManifest(root, rawOptions = {}) {
  const manifest = await readVerifiedManifest(root, rawOptions);
  return {
    schema: manifest.schema,
    backupId: manifest.backupId,
    recoverySetId: manifest.recoverySet.id,
    artifactCount: manifest.artifacts.length,
    encrypted: manifest.encryption.method !== "none",
    objectsIncluded: manifest.objects.included,
  };
}

export async function readVerifiedManifest(root, rawOptions = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, MANIFEST_NAME), "utf8"));
  validateManifestShape(manifest);
  verifyManifestMac(manifest, integrityKeyFrom(rawOptions));
  const actual = await collectArtifacts(root);
  verifyArtifactsMatch(manifest, actual);
  verifyRecoverySet(manifest);
  return manifest;
}

function verifyArtifactsMatch(manifest, actual) {
  const expected = manifest.artifacts;
  if (actual.length !== expected.length) {
    throw new Error(
      `artifact inventory mismatch: manifest=${String(expected.length)} actual=${String(actual.length)}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const observed = actual[index];
    if (
      wanted.path !== observed.path ||
      wanted.bytes !== observed.bytes ||
      wanted.sha256 !== observed.sha256
    ) {
      throw new Error(`artifact checksum mismatch: ${wanted.path}`);
    }
  }
}

function verifyRecoverySet(manifest) {
  const recoverySetId = createHash("sha256").update(recoverySetMaterial(manifest)).digest("hex");
  if (recoverySetId !== manifest.recoverySet.id) {
    throw new Error("recovery-set linkage digest mismatch");
  }
}

function normalizeCreateOptions(options) {
  const tier = requiredString(options.tier, "tier");
  if (!["personal", "business", "enterprise", "sovereign"].includes(tier)) {
    throw new Error(`unsupported tier: ${tier}`);
  }
  const encryption = requiredString(options.encryption, "encryption");
  if (!["none", "age", "kms"].includes(encryption)) {
    throw new Error(`unsupported encryption method: ${encryption}`);
  }
  const normalized = {
    backupId: requiredString(options.backupId, "backup id"),
    tier,
    createdAt: timestamp(options.createdAt, "created at"),
    databaseCapturedAt: timestamp(options.databaseCapturedAt, "database captured at"),
    objectsCapturedAt: timestamp(options.objectsCapturedAt, "objects captured at"),
    databaseMode: requiredString(options.databaseMode, "database mode"),
    objectsIncluded: booleanValue(options.objectsIncluded),
    objectBucket: String(options.objectBucket ?? ""),
    objectVersioning: String(options.objectVersioning ?? "Unavailable"),
    objectReplication: String(options.objectReplication ?? "not-applicable"),
    encryption,
    keyCustodyRef: String(options.keyCustodyRef ?? ""),
    offHostUri: String(options.offHostUri ?? ""),
    retentionDays: integerValue(options.retentionDays ?? 0, "retention days"),
    integrityKey: integrityKeyFrom(options),
    integrityKeyRef: requiredString(
      options.integrityKeyRef ?? process.env.HELIX_BACKUP_MANIFEST_HMAC_KEY_REF,
      "manifest integrity key reference",
    ),
  };
  if (!["logical-dump", "physical-basebackup"].includes(normalized.databaseMode)) {
    throw new Error(`unsupported database mode: ${normalized.databaseMode}`);
  }
  if (normalized.objectsIncluded && normalized.objectBucket.length === 0) {
    throw new Error("object bucket is required when objects are included");
  }
  if (normalized.keyCustodyRef.includes("\n") || normalized.keyCustodyRef.includes("\0")) {
    throw new Error("key custody reference contains invalid characters");
  }
  if (PRODUCTION_TIERS.has(tier)) {
    if (encryption === "none") throw new Error(`${tier} backup must be encrypted`);
    if (normalized.keyCustodyRef.length === 0) {
      throw new Error(`${tier} backup requires a non-secret key custody reference`);
    }
    if (
      !/^(?:arn:|[a-z][a-z0-9+.-]*:\/\/)\S+$/iu.test(normalized.keyCustodyRef) ||
      /AGE-SECRET-KEY|BEGIN [A-Z ]*PRIVATE KEY/iu.test(normalized.keyCustodyRef)
    ) {
      throw new Error(`${tier} key custody reference must be a non-secret URI or ARN`);
    }
    if (!normalized.offHostUri.startsWith("s3://")) {
      throw new Error(`${tier} backup requires an s3:// off-host destination`);
    }
    if (normalized.retentionDays < MINIMUM_RETENTION_DAYS[tier]) {
      throw new Error(
        `${tier} backup requires retention of at least ${String(MINIMUM_RETENTION_DAYS[tier])} days`,
      );
    }
    if (!normalized.objectsIncluded) {
      throw new Error(`${tier} backup must include the object-store snapshot`);
    }
    if (normalized.objectVersioning !== "Enabled") {
      throw new Error(`${tier} object-store versioning must be Enabled`);
    }
    if (normalized.objectReplication !== "configured") {
      throw new Error(`${tier} object-store replication must be configured`);
    }
  }
  return normalized;
}

function validateManifestShape(manifest) {
  if (manifest?.schema !== BACKUP_MANIFEST_SCHEMA) {
    throw new Error(`unsupported manifest schema: ${String(manifest?.schema)}`);
  }
  requiredString(manifest.backupId, "backup id");
  timestamp(manifest.createdAt, "created at");
  timestamp(manifest.recoverySet?.databaseCapturedAt, "database captured at");
  timestamp(manifest.recoverySet?.objectsCapturedAt, "objects captured at");
  if (!SHA256.test(String(manifest.recoverySet?.id))) {
    throw new Error("recovery-set id must be a sha256 digest");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("manifest artifact inventory must not be empty");
  }
  let previous = "";
  for (const artifact of manifest.artifacts) {
    const path = requiredString(artifact.path, "artifact path");
    if (
      [...path].some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code <= 31 || code === 127);
      })
    ) {
      throw new Error(
        `artifact path contains unsupported control characters: ${JSON.stringify(path)}`,
      );
    }
    if (path <= previous) throw new Error("manifest artifacts must be uniquely sorted");
    previous = path;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new Error(`invalid artifact size: ${path}`);
    }
    if (!SHA256.test(String(artifact.sha256))) {
      throw new Error(`invalid artifact checksum: ${path}`);
    }
  }
  if (manifest.encryption?.plaintextKeyMaterialIncluded !== false) {
    throw new Error("manifest must assert that plaintext key material is excluded");
  }
  if (manifest.integrity?.algorithm !== "hmac-sha256") {
    throw new Error("manifest integrity algorithm must be hmac-sha256");
  }
  requiredString(manifest.integrity?.keyRef, "manifest integrity key reference");
  if (!SHA256.test(String(manifest.integrity?.mac))) {
    throw new Error("manifest integrity MAC must be a sha256 digest");
  }
}

function integrityKeyFrom(options) {
  const value = options.integrityKey ?? process.env.HELIX_BACKUP_MANIFEST_HMAC_KEY;
  const key = requiredString(value, "manifest integrity key");
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("manifest integrity key must be at least 32 bytes");
  }
  return key;
}

function recoverySetMaterial(manifest) {
  return JSON.stringify({
    schema: manifest.schema,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    tier: manifest.tier,
    recoverySet: {
      databaseCapturedAt: manifest.recoverySet.databaseCapturedAt,
      objectsCapturedAt: manifest.recoverySet.objectsCapturedAt,
      maximumCaptureSkewSeconds: manifest.recoverySet.maximumCaptureSkewSeconds,
    },
    database: manifest.database,
    objects: manifest.objects,
    encryption: manifest.encryption,
    resilience: manifest.resilience,
    artifacts: manifest.artifacts,
  });
}

function manifestMacMaterial(manifest) {
  return JSON.stringify({
    ...manifest,
    integrity: {
      algorithm: manifest.integrity.algorithm,
      keyRef: manifest.integrity.keyRef,
    },
  });
}

function createManifestMac(manifest, integrityKey) {
  return createHmac("sha256", integrityKey).update(manifestMacMaterial(manifest)).digest("hex");
}

function verifyManifestMac(manifest, integrityKey) {
  const expected = Buffer.from(createManifestMac(manifest, integrityKey), "hex");
  const actual = Buffer.from(manifest.integrity.mac, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("manifest integrity MAC mismatch");
  }
}

async function collectArtifacts(root) {
  const absoluteRoot = resolve(root);
  const artifacts = [];
  await walk(absoluteRoot, async (path) => {
    const relativePath = relative(absoluteRoot, path).split(sep).join("/");
    if (relativePath === MANIFEST_NAME) return;
    artifacts.push({
      path: relativePath,
      bytes: (await lstat(path)).size,
      sha256: await sha256File(path),
    });
  });
  return artifacts.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}

async function walk(directory, visit) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else if (entry.isFile()) await visit(path);
    else throw new Error(`backup artifact must be a regular file: ${path}`);
  }
}

function requireArtifact(artifacts, path) {
  const artifact = artifacts.find((entry) => entry.path === path);
  if (artifact === undefined) {
    throw new Error(`required backup artifact missing: ${path}`);
  }
  return artifact;
}

function requireArtifactPrefix(artifacts, prefix) {
  if (!artifacts.some((artifact) => artifact.path.startsWith(prefix))) {
    throw new Error(`required backup artifact prefix missing: ${prefix}`);
  }
}

function parseCli(args) {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    return { command: "help", options: {} };
  }
  if (!["create", "verify", "object-samples"].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  const options = { json: false };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    const key = OPTION_KEYS_BY_FLAG[argument];
    if (key === undefined) throw new Error(`unknown option: ${argument}`);
    options[key] = value;
  }
  options.root = requiredString(options.root, "root");
  return { command, options };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function timestamp(value, name) {
  const parsed = new Date(requiredString(value, name));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be ISO-8601`);
  return parsed.toISOString();
}

function booleanValue(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`expected true or false, received: ${String(value)}`);
}

function integerValue(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be an integer`);
  return parsed;
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

// Ed25519 manifests preserve local backups and require an explicit public key.
async function createSignedManifest(rootPath, targetManifest, targetSignature, privateKeyPath) {
  const manifest = parseObject(await readFile(targetManifest, "utf8"), "manifest");
  const files = await inventory(rootPath);
  if (manifest.resilience !== undefined) {
    // New signed backups retain the recovery evidence contract alongside legacy restore fields.
    const artifacts = files.map(({ path, size, sha256 }) => ({ path, bytes: size, sha256 }));
    requireArtifact(artifacts, "consistency/database.tsv");
    requireArtifact(artifacts, "postgres.dump");
    const boundary = manifest.postgres?.snapshot_boundary;
    if (!Number.isFinite(Date.parse(boundary)))
      throw new Error("Invalid database snapshot boundary");
    manifest.schema = BACKUP_MANIFEST_SCHEMA;
    manifest.backupId = manifest.backup_id;
    manifest.createdAt = manifest.created_at;
    manifest.database = { mode: "logical-dump", consistencyArtifact: "consistency/database.tsv" };
    manifest.recoverySet = {
      databaseCapturedAt: boundary,
      objectsCapturedAt: boundary,
      maximumCaptureSkewSeconds: 0,
    };
    manifest.artifacts = artifacts;
    if (manifest.objects?.included === true) {
      requireArtifact(artifacts, "objects/inventory.json");
      const objectInventory = parseObject(
        await readFile(resolve(rootPath, "objects/inventory.json"), "utf8"),
        "object inventory",
      );
      if (!Array.isArray(objectInventory.objects)) throw new Error("Object inventory is invalid");
      manifest.objects.sampledCorpus = objectInventory.objects.slice(0, 25).map((object) => {
        const artifact = requireArtifact(artifacts, `objects/${object.file}`);
        if (artifact.sha256 !== object.sha256) throw new Error("Object sample digest mismatch");
        return { ...artifact, key: object.key };
      });
    } else manifest.objects.sampledCorpus = [];
    manifest.recoverySet.id = createHash("sha256")
      .update(recoverySetMaterial(manifest))
      .digest("hex");
  }
  manifest.integrity = {
    algorithm: "sha256",
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("manifest signing key must be Ed25519");
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
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("manifest verification key must be Ed25519");
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
  await walk(rootPath, async (path) => {
    files.push({
      path: canonicalRelativePath(rootPath, path),
      size: (await lstat(path)).size,
      sha256: await sha256File(path),
    });
  });
  return files
    .filter((file) => file.path !== "manifest.json" && file.path !== "manifest.sig")
    .sort((left, right) => left.path.localeCompare(right.path));
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
