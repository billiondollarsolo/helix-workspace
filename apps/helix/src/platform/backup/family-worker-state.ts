import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  backupCoverage,
  familyBackupBinding,
  familyBackupJob,
  familyBackupPolicy,
} from "./family-protocol.js";

const command = z.array(z.string().min(1).max(4096)).min(1).max(64);
export const workerConfiguration = z
  .object({
    binding: familyBackupBinding,
    stateDirectory: z.string().min(1),
    managementKeyFile: z.string().min(1),
    restoreKeyFile: z.string().min(1).optional(),
    scheduler: z.enum(["worker", "external"]),
    localSchedulerDisabled: z.boolean().default(false),
    destinations: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u))
      .min(1)
      .max(32),
    minimumRetentionDays: z.number().int().min(1).max(3650),
    requiredCoverage: z.array(backupCoverage).min(1).max(4),
    initialPolicy: familyBackupPolicy,
    commands: z
      .object({ backup: command, verify: command.optional(), restore: command.optional() })
      .strict(),
    timeoutSeconds: z.number().int().min(1).max(86400).default(14400),
    healthUrl: z.string().url().optional(),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(3081),
    tls: z.object({ certFile: z.string(), keyFile: z.string() }).strict().optional(),
    privateHttp: z.boolean().default(false),
  })
  .strict();
export type WorkerConfiguration = z.infer<typeof workerConfiguration>;
const stateSchema = z
  .object({
    version: z.literal(1),
    binding: familyBackupBinding,
    policy: familyBackupPolicy,
    owner: z.enum(["local", "workspace"]),
    revokedKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
    jobs: z.array(familyBackupJob).max(10000),
  })
  .strict();
export type WorkerState = z.infer<typeof stateSchema>;

function rejectSymlinks(path: string) {
  let parent = resolve(path);
  while (parent !== dirname(parent)) {
    try {
      if (lstatSync(parent).isSymbolicLink())
        throw new Error("Recovery paths cannot contain symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    parent = dirname(parent);
  }
}
export function privateStateDirectory(path: string) {
  rejectSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const dir = lstatSync(path);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
    throw new Error("Recovery state directory must be private and app-owned.");
  rejectSymlinks(join(path, "worker.lock"));
}
export function protectedFile(path: string): string {
  rejectSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !(
        (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0) ||
        (stat.uid === 0 && stat.gid === process.getgid?.() && (stat.mode & 0o137) === 0)
      ) ||
      stat.size > 32 * 1024 * 1024
    )
      throw new Error("Recovery files must be private, app-owned regular files.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function persist(path: string, value: unknown) {
  const temporary = join(dirname(path), `.${randomUUID()}.partial`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function loadState(config: WorkerConfiguration): WorkerState {
  privateStateDirectory(config.stateDirectory);
  const file = join(config.stateDirectory, "state.json");
  const state = existsSync(file)
    ? stateSchema.parse(JSON.parse(protectedFile(file)))
    : {
        version: 1 as const,
        binding: config.binding,
        policy: config.initialPolicy,
        owner: "local" as const,
        revokedKeys: [],
        jobs: [],
      };
  if (JSON.stringify(state.binding) !== JSON.stringify(config.binding))
    throw new Error(
      "Recovery state belongs to another installation; reviewed re-enrollment is required.",
    );
  for (const job of state.jobs)
    if (job.status === "running") {
      job.status = "unknown";
      job.error = "interrupted";
    }
  persist(file, state);
  return state;
}
export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
export function matchesKey(supplied: string, file: string) {
  const expected = protectedFile(file).trim();
  if (!/^[a-f0-9]{64}$/u.test(expected))
    throw new Error("Recovery keys must contain 64 random hexadecimal characters.");
  return timingSafeEqual(Buffer.from(keyHash(supplied)), Buffer.from(keyHash(expected)));
}
