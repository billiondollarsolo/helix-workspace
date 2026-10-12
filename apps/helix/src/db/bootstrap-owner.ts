import { parseArgs } from "node:util";
import { env, runtimeEnvironment } from "../config/env.js";
import { bootstrapWorkspaceOwner } from "../platform/auth/bootstrap-owner.js";
import { resolveDefaultOrgInput } from "../platform/tenancy/orgs.js";
import { createSqlClient } from "./client.js";

// Usage (inside the application container, after Helix has started once):
//   node dist/db/bootstrap-owner.js --email owner@example.com [--name "Owner Name"]
const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" } },
  strict: true,
});
const email = values.email?.trim() ?? "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  console.error('Usage: bootstrap-owner --email owner@example.com [--name "Owner Name"]');
  process.exit(2);
}

const config = env();
const publicBaseUrl = config.HELIX_PUBLIC_URL ?? config.BETTER_AUTH_URL ?? config.PUBLIC_BASE_URL;
if (publicBaseUrl === undefined) {
  console.error("Set HELIX_PUBLIC_URL so the sign-up link points at this workspace.");
  process.exit(2);
}
const sql = createSqlClient();
try {
  const result = await bootstrapWorkspaceOwner(sql, {
    orgId: resolveDefaultOrgInput(runtimeEnvironment()).id,
    email,
    displayName: values.name,
    publicBaseUrl,
  });
  if (result.status === "workspace_missing") {
    console.error("The workspace does not exist yet. Start Helix once, then run this again.");
    process.exitCode = 1;
  } else if (result.status === "already_joined") {
    console.log(
      `${email} already has a sign-in for this workspace. Use "Forgot password" on the sign-in page to recover access.`,
    );
  } else {
    console.log(`Owner ${email} is ready. Open this link to choose a password and sign in:`);
    console.log(result.inviteUrl);
    console.log(`The link works once and expires ${result.expiresAt.toISOString()}.`);
  }
} finally {
  await sql.end();
}
