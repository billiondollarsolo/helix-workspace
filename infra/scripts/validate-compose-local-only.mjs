import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const compose = await readFile(new URL("docker-compose.yml", root), "utf8");
const runtimeRoles = await readFile(
  new URL("infra/postgres/init/002_runtime_roles.sql", root),
  "utf8",
);

const required = [
  "# Local development only.",
  "name: helix-local-dev",
  "NODE_ENV: development",
  "DATABASE_URL: postgres://helix_app:",
  '"127.0.0.1:${HELIX_PORT:-28431}:3000"',
];
const forbidden = ["NODE_ENV: ${", "NODE_ENV: production"];
const failures = [
  ...required.filter((marker) => !compose.includes(marker)).map((marker) => `missing ${marker}`),
  ...forbidden.filter((marker) => compose.includes(marker)).map((marker) => `found ${marker}`),
  ...["helix_app", "helix_worker", "helix_readonly"]
    .filter((role) => !runtimeRoles.includes(role))
    .map((role) => `missing constrained PostgreSQL role ${role}`),
];

if (failures.length > 0) {
  process.stderr.write(`Compose local-only policy failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Compose is explicitly constrained to local development.\n");
}
