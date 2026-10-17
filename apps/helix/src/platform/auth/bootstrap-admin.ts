import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse } from "node:path";
import { hashPassword } from "better-auth/crypto";
import type postgres from "postgres";
import { z } from "zod";
import { createCredentialUserForActor } from "../signup/verification.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { bootstrapWorkspaceOwner } from "./bootstrap-owner.js";

function assertNoSymbolicLinks(file: string): void {
  let path = file;
  while (path !== parse(path).root) {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Bootstrap secret paths cannot contain symbolic links");
    path = dirname(path);
  }
}

export function bootstrapPassword(file: string): string {
  assertNoSymbolicLinks(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    const applicationOwned = info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
    const projectedSecret =
      info.uid === 0 && info.gid === process.getgid?.() && (info.mode & 0o137) === 0;
    if (!info.isFile() || (!applicationOwned && !projectedSecret) || info.size > 1024)
      throw new Error(
        "Bootstrap password must be an owner-only regular file owned by the application user",
      );
    const value = readFileSync(fd, "utf8").replace(/\r?\n$/u, "");
    if (value.length < 8 || value.length > 128)
      throw new Error("Bootstrap password must contain 8 to 128 characters");
    return value;
  } finally {
    closeSync(fd);
  }
}

export async function bootstrapAdmin(
  sql: postgres.Sql,
  orgId: string,
  publicBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const enabled = env.HELIX_BOOTSTRAP_ADMIN_ENABLED;
  if (enabled === undefined || enabled === "false") return;
  if (enabled !== "true") throw new Error("HELIX_BOOTSTRAP_ADMIN_ENABLED must be true or false");
  await withTenantPostgresContext(sql, { orgId }, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`bootstrap-admin:${orgId}`}, 0))`;
    const [initialized] = await tx`select 1 from installation_admin_bootstrap where org_id=${orgId}
      union all select 1 from actors where org_id=${orgId} and type='user' limit 1`;
    if (initialized !== undefined) {
      await tx`insert into installation_admin_bootstrap(org_id) values(${orgId}) on conflict do nothing`;
      return;
    }
    const email = z.string().email().parse(env.HELIX_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase());
    const supplied = env.HELIX_BOOTSTRAP_ADMIN_PASSWORD_FILE;
    const directory = env.HELIX_BOOTSTRAP_ADMIN_STATE_DIRECTORY || "/var/lib/helix/bootstrap";
    const file = supplied || join(directory, "bootstrap-admin.password");
    if (!supplied) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      assertNoSymbolicLinks(directory);
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error("Bootstrap directory must be private and owned by the application user");
      try {
        writeFileSync(file, randomBytes(32).toString("base64url") + "\n", {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const passwordHash = await hashPassword(bootstrapPassword(file));
    const owner = await bootstrapWorkspaceOwner(sql, {
      orgId,
      email,
      publicBaseUrl,
      displayName: env.HELIX_BOOTSTRAP_ADMIN_NAME?.trim() || email,
    });
    if (owner.status !== "invited")
      throw new Error("Workspace must exist and be uninitialized for administrator bootstrap");
    const created = await createCredentialUserForActor(tx, { orgId, email, passwordHash });
    if (created?.actorId !== owner.actorId) throw new Error("Bootstrap owner activation failed");
    await tx`update signup_onboarding_invites set expires_at=now(), updated_at=now()
      where org_id=${orgId} and metadata->>'actorId'=${owner.actorId} and accepted_at is null`;
    await tx`insert into installation_admin_bootstrap(org_id,user_id,initial_password_hash)
      values(${orgId},${created.betterAuthUserId},${supplied ? null : passwordHash})`;
  });
}

export async function bootstrapPasswordChangeRequired(
  sql: postgres.Sql,
  orgId: string,
  userId: string,
): Promise<boolean> {
  return withTenantPostgresContext(sql, { orgId }, async (tx) => {
    const [required] =
      await tx`select 1 from installation_admin_bootstrap b join account a on a."userId"=b.user_id
      where b.org_id=${orgId} and b.user_id=${userId} and a."providerId"='credential'
      and a.password=b.initial_password_hash`;
    return required !== undefined;
  });
}
