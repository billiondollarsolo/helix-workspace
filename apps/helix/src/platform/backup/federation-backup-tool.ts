/** Operator-side bridge to the existing Bot cold backup and Workspace signed backup tools. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { z } from "zod";
import {
  federationBackupBinding,
  federationBackupPolicy,
  federationBackupReceipt,
  federationBackupRequest,
  type FederationBackupReceipt,
} from "./federation-protocol.js";
import { persist, protectedFile } from "./federation-worker-state.js";
const directory = z.string().min(1);
const configSchema = z
  .object({
    application: z.enum(["bot", "workspace"]),
    repository: directory,
    workspaceRecoveryTools: directory,
    sourceDirectory: directory.optional(),
    configurationDirectory: directory.optional(),
    appVersion: z.string().min(1).max(64),
    destinations: z.record(
      z.string(),
      z
        .object({
          directory,
          recipientsFile: directory,
          identityFile: directory,
          keyCustodyRef: z.string(),
          offHost: z.boolean(),
          offHostUri: z
            .string()
            .regex(/^s3:\/\/[a-z0-9][a-z0-9./_-]+$/u)
            .optional(),
        })
        .strict(),
    ),
    backupArgs: z.array(z.string()).default([]),
    restoreArgs: z.array(z.string()).default([]),
    restoreDirectory: directory.optional(),
    restoreDatabaseUrlFile: directory.optional(),
    postgresTls: z.enum(["off", "verify-full"]).default("verify-full"),
    postgresCaFile: directory.optional(),
  })
  .strict();
const requestSchema = z
  .object({
    request: federationBackupRequest,
    policy: federationBackupPolicy,
    binding: federationBackupBinding,
    source: federationBackupReceipt.nullable(),
  })
  .strict();
async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("Recovery command missing");
  await new Promise<void>((resolveJob, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", env, shell: false });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveJob();
      else reject(new Error("Recovery tool failed"));
    });
  });
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part as Buffer);
  return hash.digest("hex");
}
async function inventory(root: string) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  async function walk(path: string, prefix: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9._-]+$/u.test(entry.name) || entry.name === "..")
        throw new Error("Unsafe recovery filename");
      const file = join(path, entry.name),
        relative = prefix + entry.name,
        stat = lstatSync(file);
      if (entry.isSymbolicLink() || (stat.nlink > 1 && !entry.isDirectory()))
        throw new Error("Recovery links are prohibited");
      if (entry.isDirectory()) await walk(file, relative + "/");
      else if (entry.isFile())
        files.push({ path: relative, sha256: await digest(file), bytes: stat.size });
      else throw new Error("Only regular recovery files are supported");
      if (files.length > 100000) throw new Error("Recovery inventory exceeds its bound");
    }
  }
  await walk(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function federationBackupTool(
  configPath: string,
  requestPath: string,
  receiptPath: string,
) {
  process.umask(0o077);
  const config = configSchema.parse(JSON.parse(protectedFile(configPath))),
    input = requestSchema.parse(JSON.parse(protectedFile(requestPath)));
  if (config.application !== input.binding.application)
    throw new Error("Recovery tools belong to a different application");
  const { request, policy } = input,
    destination = config.destinations[input.source?.destinationRef ?? policy.destinationRef];
  if (!destination) throw new Error("Recovery destination was not approved");
  mkdirSync(destination.directory, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(destination.directory);
  if (
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.getuid?.() ||
    (rootStat.mode & 0o077) !== 0
  )
    throw new Error("Private recovery destination required");
  const backupId = request.backupId ?? request.id;
  const archive = join(destination.directory, `${backupId}.federation.age`),
    sidecar = join(destination.directory, `${backupId}.federation.json`);
  const work = join(dirname(receiptPath), "bundle");
  mkdirSync(work, { mode: 0o700 });
  try {
    if (request.kind === "backup") {
      if (existsSync(archive) || existsSync(sidecar))
        throw new Error("Backup artifacts already exist; overwrite is prohibited");
      const payload = join(work, "payload");
      if (config.application === "bot") {
        if (!config.sourceDirectory)
          throw new Error(
            "Bot full backup requires its private source directory and a stopped application",
          );
        await run([
          process.execPath,
          join(config.repository, "scripts/backup-local.mjs"),
          "backup",
          config.sourceDirectory,
          payload,
          ...config.backupArgs,
        ]);
        const manifest = JSON.parse(protectedFile(join(payload, "manifest.json"))) as {
          installationId: string;
        };
        if (manifest.installationId !== input.binding.installationId)
          throw new Error("Bot snapshot belongs to another installation");
      } else {
        if (!config.configurationDirectory)
          throw new Error(
            "Workspace full backup requires its selected deployment configuration bundle",
          );
        mkdirSync(payload, { mode: 0o700 });
        await run([
          "bash",
          join(config.repository, "infra/scripts/backup.sh"),
          "--backup-id",
          backupId,
          "--output-dir",
          payload,
          ...config.backupArgs,
          "--age-recipients-file",
          destination.recipientsFile,
          "--retention-days",
          String(policy.retentionDays),
          "--key-custody-ref",
          destination.keyCustodyRef,
          "--object-backup",
          "--execute",
        ]);
        const configFiles = await inventory(config.configurationDirectory);
        if (
          !configFiles.length ||
          configFiles.some((file) => !/[.](json|ya?ml|toml|conf)$/u.test(file.path))
        )
          throw new Error(
            "Choose an explicit configuration bundle; keep recovery keys and secret identities in independent custody",
          );
        cpSync(config.configurationDirectory, join(work, "configuration"), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
        const copied = await inventory(join(work, "configuration"));
        if (JSON.stringify(configFiles) !== JSON.stringify(copied))
          throw new Error("Deployment configuration changed during capture");
        const metadata = JSON.parse(
          readFileSync(join(payload, `${backupId}.tar.gz.age.manifest.json`), "utf8"),
        ) as { objects?: { included?: boolean } };
        if (!metadata.objects?.included) throw new Error("Workspace backup omitted object storage");
      }
      const files = await inventory(work),
        createdAt = new Date().toISOString();
      const snapshot = JSON.parse(
        protectedFile(
          join(
            payload,
            config.application === "bot" ? "manifest.json" : `${backupId}.tar.gz.age.manifest.json`,
          ),
        ),
      ) as { createdAt?: string; postgres?: { snapshot_boundary?: string } };
      const recoveryPoint =
        config.application === "bot" ? snapshot.createdAt : snapshot.postgres?.snapshot_boundary;
      if (!recoveryPoint || !Number.isFinite(Date.parse(recoveryPoint)))
        throw new Error("Snapshot recovery boundary is missing");
      const receipt: FederationBackupReceipt = {
        backupId,
        createdAt,
        artifactDigest: "0".repeat(64),
        manifestDigest: "0".repeat(64),
        encrypted: true,
        destinationRef: policy.destinationRef,
        retentionDays: policy.retentionDays,
        offHost: destination.offHost,
        keyCustodyRef: destination.keyCustodyRef,
        coverage:
          config.application === "bot"
            ? ["database", "files", "configuration"]
            : ["database", "objects", "configuration"],
        appVersion: config.appVersion,
        schemaVersion:
          config.application === "bot"
            ? String(
                (
                  JSON.parse(protectedFile(join(work, "payload/manifest.json"))) as {
                    schemaVersion: number;
                  }
                ).schemaVersion,
              )
            : String(
                (
                  JSON.parse(
                    readFileSync(
                      join(work, `payload/${backupId}.tar.gz.age.manifest.json`),
                      "utf8",
                    ),
                  ) as { postgres?: { migrations?: unknown[] } }
                ).postgres?.migrations?.length ?? 0,
              ),
        databaseRecoveryPoint: new Date(recoveryPoint).toISOString(),
        objectRecoveryPoint:
          config.application === "workspace" ? new Date(recoveryPoint).toISOString() : null,
        verifiedAt: null,
        restoredAt: null,
        targetDatabase: null,
        targetObjectBucket: null,
      };
      persist(join(work, "manifest.json"), {
        format: "helix.federation.bundle.v1",
        binding: input.binding,
        receipt,
        files,
      });
      await run([
        "tar",
        "-C",
        work,
        "-czf",
        join(dirname(receiptPath), "bundle.tar.gz"),
        ...readdirSync(work),
      ]);
      await run([
        "age",
        "-R",
        destination.recipientsFile,
        "-o",
        archive,
        join(dirname(receiptPath), "bundle.tar.gz"),
      ]);
      receipt.artifactDigest = await digest(archive);
      receipt.manifestDigest = await digest(join(work, "manifest.json"));
      if (destination.offHostUri) {
        await run([
          "aws",
          "s3",
          "cp",
          archive,
          `${destination.offHostUri.replace(/\/$/u, "")}/${backupId}.federation.age`,
        ]);
      }
      persist(sidecar, receipt);
      persist(receiptPath, receipt);
      // The original promise is a floor: a shorter new policy never erases an older retention commitment.
      for (const file of readdirSync(destination.directory).filter((name) =>
        /^[a-f0-9-]{36}[.]federation[.]json$/u.test(name),
      )) {
        const prior = federationBackupReceipt.parse(
          JSON.parse(protectedFile(join(destination.directory, file))),
        );
        if (
          prior.backupId !== backupId &&
          Date.now() - Date.parse(prior.createdAt) >
            Math.max(prior.retentionDays, policy.retentionDays) * 86400000
        ) {
          rmSync(join(destination.directory, `${prior.backupId}.federation.age`));
          rmSync(join(destination.directory, file));
        }
      }
      return;
    }
    const source = input.source;
    if (
      !source ||
      source.backupId !== backupId ||
      (await digest(archive)) !== source.artifactDigest
    )
      throw new Error("Recovery ciphertext differs from its recorded artifact");
    const plain = join(dirname(receiptPath), "bundle.tar.gz");
    await run(["age", "-d", "-i", destination.identityFile, "-o", plain, archive]);
    await run(["python3", join(config.workspaceRecoveryTools, "safe_extract_tar.py"), plain, work]);
    if ((await digest(join(work, "manifest.json"))) !== source.manifestDigest)
      throw new Error("Recovery manifest differs from its recorded digest");
    const manifest = JSON.parse(protectedFile(join(work, "manifest.json"))) as {
      format: string;
      binding: unknown;
      files: unknown;
    };
    const all = await inventory(work);
    const actual = all.filter((file) => file.path !== "manifest.json");
    if (
      manifest.format !== "helix.federation.bundle.v1" ||
      JSON.stringify(manifest.binding) !== JSON.stringify(input.binding) ||
      JSON.stringify(manifest.files) !== JSON.stringify(actual)
    )
      throw new Error("Recovery inventory or installation binding differs");
    const receipt = { ...source, verifiedAt: new Date().toISOString() };
    if (request.kind === "restore") {
      if (source.appVersion !== config.appVersion)
        throw new Error("Use recovery tools matching this backup's application version");
      if (config.application === "workspace") {
        await run([
          "bash",
          join(config.repository, "infra/scripts/restore.sh"),
          "--backup",
          join(work, `payload/${backupId}.tar.gz.age`),
          ...config.restoreArgs,
          "--age-identity",
          destination.identityFile,
          "--target-db",
          request.targetDatabase ?? "",
          "--object-target-bucket",
          request.targetObjectBucket ?? "",
          "--restore-objects",
          "--no-object-switch",
          "--verify",
          "--execute",
        ]);
      } else {
        if (!config.restoreDatabaseUrlFile || !config.restoreDirectory)
          throw new Error(
            "Bot recovery requires an isolated database operator and restore directory",
          );
        mkdirSync(config.restoreDirectory, { recursive: true, mode: 0o700 });
        const url = new URL(protectedFile(config.restoreDatabaseUrlFile).trim());
        const sql = postgres(url.href, {
          ssl:
            config.postgresTls === "off"
              ? false
              : {
                  rejectUnauthorized: true,
                  ...(config.postgresCaFile
                    ? { ca: readFileSync(config.postgresCaFile, "utf8") }
                    : {}),
                },
        });
        try {
          await sql.unsafe(`create database "${request.targetDatabase ?? ""}"`);
        } finally {
          await sql.end();
        }
        url.pathname = "/" + (request.targetDatabase ?? "");
        const file = join(dirname(receiptPath), "restore-postgres.url");
        writeFileSync(file, url.href, { mode: 0o600, flag: "wx" });
        await run([
          process.execPath,
          join(config.repository, "scripts/backup-local.mjs"),
          "restore",
          join(work, "payload"),
          join(config.restoreDirectory, request.targetDatabase ?? ""),
          ...config.restoreArgs,
          "--postgres-url-file",
          file,
          "--postgres-tls",
          config.postgresTls === "off" ? "disable" : config.postgresTls,
          ...(config.postgresCaFile ? ["--postgres-ca-file", config.postgresCaFile] : []),
        ]);
      }
      receipt.restoredAt = new Date().toISOString();
      receipt.targetDatabase = request.targetDatabase ?? "";
      receipt.targetObjectBucket = request.targetObjectBucket ?? null;
    }
    persist(receiptPath, receipt);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(join(dirname(receiptPath), "bundle.tar.gz"), { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = process.argv[2],
    environment = z
      .object({
        HELIX_FEDERATION_BACKUP_REQUEST_FILE: z.string().optional(),
        HELIX_FEDERATION_BACKUP_RECEIPT_FILE: z.string().optional(),
      })
      .parse(process.env),
    request = environment.HELIX_FEDERATION_BACKUP_REQUEST_FILE,
    receipt = environment.HELIX_FEDERATION_BACKUP_RECEIPT_FILE;
  if (!config || !request || !receipt) process.exitCode = 1;
  else
    void federationBackupTool(config, request, receipt).catch(() => {
      process.stderr.write('{"event":"federation_backup_tool_failed"}\n');
      process.exitCode = 1;
    });
}
