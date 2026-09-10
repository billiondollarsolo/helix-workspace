import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, expect } from "vitest";

// Historical migrations change policies and functions. Each live file needs its
// own copy of the migrated database, otherwise execution order changes results.
const templateUrl = process.env.HELIX_TEST_DATABASE_TEMPLATE;
const testPath = expect.getState().testPath;
if (
  templateUrl !== undefined &&
  testPath !== undefined &&
  /DATABASE_URL|skipUnlessLiveDatabase/u.test(readFileSync(testPath, "utf8"))
) {
  const template = new URL(templateUrl);
  const databaseName = `helix_test_${randomUUID().replaceAll("-", "")}`;
  const controlUrl = new URL(template);
  controlUrl.pathname = "/postgres";
  const control = postgres(controlUrl.href, { max: 1 });
  await control`create database ${control(databaseName)} template ${control(template.pathname.slice(1))}`;
  for (const key of [
    "DATABASE_URL",
    "CARD_DAV_DATABASE_URL",
    "HELIX_MIGRATION_DATABASE_URL",
    "HELIX_RLS_APP_DATABASE_URL",
    "HELIX_RLS_WORKER_DATABASE_URL",
    "HELIX_RLS_READONLY_DATABASE_URL",
  ]) {
    const value = process.env[key];
    if (value === undefined) continue;
    const url = new URL(value);
    url.pathname = `/${databaseName}`;
    process.env[key] = url.href;
  }
  afterAll(async () => {
    await control`drop database ${control(databaseName)} with (force)`;
    await control.end();
  });
}
