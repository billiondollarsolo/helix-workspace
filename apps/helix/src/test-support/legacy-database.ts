import { randomUUID } from "node:crypto";
import postgres from "postgres";

/** Empty disposable database for executing unchanged historical migrations. */
export async function createLegacyTestDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/postgres";
  const control = postgres(url.href, { max: 1 });
  const name = `helix_legacy_${randomUUID().replaceAll("-", "")}`;
  await control`create database ${control(name)} template template0`;
  url.pathname = `/${name}`;
  const sql = postgres(url.href, { max: 1, onnotice: () => undefined });
  return {
    sql,
    async close() {
      await sql.end();
      await control`drop database ${control(name)} with (force)`;
      await control.end();
    },
  };
}
