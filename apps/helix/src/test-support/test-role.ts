import { randomUUID } from "node:crypto";

/**
 * A login role name and password unique to this test run.
 *
 * Roles are cluster-wide, not per database: a fixed name collides with any
 * other run on the same PostgreSQL server (another worktree, CI's per-file
 * template copies, a parallel file), which fails `create role` or drops the
 * role from under the other run.
 */
export function uniqueTestRole(prefix: string): {
  readonly name: string;
  readonly password: string;
} {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { name: `${prefix}_${suffix}`, password: `${prefix}_password_${suffix}` };
}
