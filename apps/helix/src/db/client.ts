import postgres from "postgres";

export function createSqlClient(databaseUrl = process.env.DATABASE_URL): postgres.Sql {
  return postgres(databaseUrl ?? "postgres://helix:helix_dev_password@localhost:28432/helix", {
    max: Number.parseInt(process.env.POSTGRES_POOL_MAX ?? "10", 10),
    prepare: false,
  });
}
