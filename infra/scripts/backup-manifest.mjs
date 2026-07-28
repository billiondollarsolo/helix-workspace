#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const BACKUP_MANIFEST_SCHEMA = "helix.backup-manifest.v3";
const MANIFEST_NAME = "manifest.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const PRODUCTION_TIERS = new Set(["business", "enterprise", "sovereign"]);
const MINIMUM_RETENTION_DAYS = { personal: 0, business: 30, enterprise: 90, sovereign: 365 };

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
    const { command, options } = parseCli(process.argv.slice(2));
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
      for (const sample of manifest.objects.sampledCorpus) {
        const prefix = `objects/${manifest.objects.bucket}/`;
        if (!sample.path.startsWith(prefix))
          throw new Error("object sample path is outside bucket");
        process.stdout.write(`${sample.sha256}\t${sample.path.slice(prefix.length)}\n`);
      }
    } else {
      process.stdout.write(usage);
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

  const recoveryLinkMaterial = [
    options.backupId,
    options.databaseCapturedAt,
    options.objectsCapturedAt,
    ...artifacts.map(({ path, sha256 }) => `${path}:${sha256}`),
  ].join("\n");
  const databaseTime = Date.parse(options.databaseCapturedAt);
  const objectsTime = Date.parse(options.objectsCapturedAt);
  const manifest = {
    schema: BACKUP_MANIFEST_SCHEMA,
    backupId: options.backupId,
    createdAt: options.createdAt,
    tier: options.tier,
    recoverySet: {
      id: createHash("sha256").update(recoveryLinkMaterial).digest("hex"),
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
  validateManifestShape(manifest);
  await writeFile(resolve(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyBackupManifest(root) {
  const manifest = await readVerifiedManifest(root);
  return {
    schema: manifest.schema,
    backupId: manifest.backupId,
    recoverySetId: manifest.recoverySet.id,
    artifactCount: manifest.artifacts.length,
    encrypted: manifest.encryption.method !== "none",
    objectsIncluded: manifest.objects.included,
  };
}

async function readVerifiedManifest(root) {
  const manifest = JSON.parse(await readFile(resolve(root, MANIFEST_NAME), "utf8"));
  validateManifestShape(manifest);
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
  const expected = manifest.artifacts;
  const recoveryLinkMaterial = [
    manifest.backupId,
    manifest.recoverySet.databaseCapturedAt,
    manifest.recoverySet.objectsCapturedAt,
    ...expected.map(({ path, sha256 }) => `${path}:${sha256}`),
  ].join("\n");
  const recoverySetId = createHash("sha256").update(recoveryLinkMaterial).digest("hex");
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
}

async function collectArtifacts(root) {
  const absoluteRoot = resolve(root);
  const artifacts = [];
  await walk(absoluteRoot, async (path) => {
    const relativePath = relative(absoluteRoot, path).split(sep).join("/");
    if (relativePath === MANIFEST_NAME) return;
    const bytes = await readFile(path);
    artifacts.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
  if (!artifacts.some((artifact) => artifact.path === path)) {
    throw new Error(`required backup artifact missing: ${path}`);
  }
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
    const key = {
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
    }[argument];
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
