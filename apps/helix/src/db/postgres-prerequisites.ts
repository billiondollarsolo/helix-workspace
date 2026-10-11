import type postgres from "postgres";

/**
 * PostgreSQL server and extension prerequisites for the Helix schema.
 *
 * The schema is not portable across PostgreSQL majors or pgvector releases:
 * migrations create `vector` columns (AI memory, vector collections, semantic
 * search), pgcrypto-backed defaults, and pg_trgm indexes. pgvector is not a
 * trusted extension, so a non-superuser database owner (the CloudNativePG
 * initdb owner, the production Compose `helix_migrator`) cannot create it; the
 * platform bootstrap must install it first. These checks turn the resulting
 * PostgreSQL permission errors into instructions an operator can act on.
 */

const MINIMUM_POSTGRES_MAJOR = 18;

interface RequiredExtension {
  readonly name: string;
  readonly minimumVersion?: string;
  readonly purpose: string;
}

const REQUIRED_POSTGRES_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: "vector",
    minimumVersion: "0.8.0",
    purpose: "AI memory, vector collections, and semantic search columns (pgvector)",
  },
  { name: "pgcrypto", purpose: "cryptographic defaults and digests" },
  { name: "pg_trgm", purpose: "trigram indexes for contacts and directory search" },
];

const BOOTSTRAP_GUIDANCE =
  "CloudNativePG installs it through bootstrap.initdb.postInitApplicationSQL (rendered by the Helix chart); Compose through infra/postgres/init/001_extensions.sql. See docs/deployment-production.md#database.";

export interface PostgresServerSnapshot {
  readonly serverVersionNum: number;
  readonly serverVersion: string;
  readonly databaseName: string;
  readonly roleName: string;
  readonly isSuperuser: boolean;
  /** CREATE on the current database: lets an owner create trusted extensions. */
  readonly canCreateInDatabase: boolean;
  readonly extensions: readonly PostgresExtensionSnapshot[];
}

export interface PostgresExtensionSnapshot {
  readonly name: string;
  /** Version the server's extension files provide, or null when not packaged. */
  readonly availableVersion: string | null;
  readonly installedVersion: string | null;
  /** Whether a database owner may create it without superuser (PG13+ `trusted`). */
  readonly trusted: boolean;
}

export type PrerequisitePhase = "migration" | "runtime";

export interface PrerequisiteEvaluation {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export class PostgresPrerequisiteError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      [
        "PostgreSQL does not meet the Helix database prerequisites:",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "PostgresPrerequisiteError";
  }
}

/** Compare dotted numeric versions such as "0.8.5" and "0.10.0". */
export function compareExtensionVersions(left: string, right: string): number {
  const parse = (version: string) =>
    version.split(".").map((part) => Number.parseInt(part.replace(/\D.*$/u, ""), 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

export function evaluatePostgresPrerequisites(
  snapshot: PostgresServerSnapshot,
  phase: PrerequisitePhase,
): PrerequisiteEvaluation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const major = Math.floor(snapshot.serverVersionNum / 10_000);
  if (major < MINIMUM_POSTGRES_MAJOR) {
    errors.push(
      `PostgreSQL ${String(MINIMUM_POSTGRES_MAJOR)} or newer is required; the server reports ${snapshot.serverVersion}. Upgrade with the dump/restore procedure in docs/deployment-production.md before running Helix.`,
    );
  }

  for (const required of REQUIRED_POSTGRES_EXTENSIONS) {
    const extension = snapshot.extensions.find((candidate) => candidate.name === required.name);
    const label = `${required.name}${required.minimumVersion === undefined ? "" : ` >= ${required.minimumVersion}`}`;
    const installed = extension?.installedVersion ?? null;
    const available = extension?.availableVersion ?? null;

    if (installed === null) {
      if (available === null) {
        errors.push(
          `Extension ${label} (${required.purpose}) is not available on this PostgreSQL server. Use a server image that packages it (the Helix Compose or CloudNativePG PostgreSQL image) or install it on the external server.`,
        );
        continue;
      }
      if (phase === "runtime") {
        errors.push(
          `Extension ${required.name} is not installed in database ${snapshot.databaseName}. Run the Helix migration job; a non-superuser owner needs the platform bootstrap to install it first. ${BOOTSTRAP_GUIDANCE}`,
        );
        continue;
      }
      // Migrations create extensions as the connecting login (0168 resets the
      // schema-owner role first), so a database owner may create trusted ones.
      const ownerMayCreate = extension?.trusted === true && snapshot.canCreateInDatabase;
      if (!snapshot.isSuperuser && !ownerMayCreate) {
        errors.push(
          `Extension ${required.name} is not installed in database ${snapshot.databaseName}, and role ${snapshot.roleName} cannot create it${extension?.trusted === true ? " (no CREATE privilege on the database)" : ` (${required.name} is not a trusted extension)`}. As a superuser, run in that database: CREATE EXTENSION IF NOT EXISTS ${required.name}; ${BOOTSTRAP_GUIDANCE}`,
        );
      }
      if (
        required.minimumVersion !== undefined &&
        compareExtensionVersions(available, required.minimumVersion) < 0
      ) {
        errors.push(
          `The server packages ${required.name} ${available}; Helix requires ${label}. Upgrade the server's ${required.name} package.`,
        );
      }
      continue;
    }

    if (
      required.minimumVersion !== undefined &&
      compareExtensionVersions(installed, required.minimumVersion) < 0
    ) {
      const serverCanUpgrade =
        available !== null && compareExtensionVersions(available, required.minimumVersion) >= 0;
      errors.push(
        serverCanUpgrade
          ? `Installed ${required.name} ${installed} is older than the required ${required.minimumVersion}. As the extension owner (normally the superuser), run: ALTER EXTENSION ${required.name} UPDATE;`
          : `Installed ${required.name} ${installed} is older than the required ${required.minimumVersion}, and the server only packages ${available ?? "no version"}. Upgrade the server's ${required.name} package, then run ALTER EXTENSION ${required.name} UPDATE;`,
      );
      continue;
    }
    if (available !== null && compareExtensionVersions(installed, available) < 0) {
      warnings.push(
        `Extension ${required.name} ${installed} is installed but the server provides ${available}. As the extension owner, run: ALTER EXTENSION ${required.name} UPDATE;`,
      );
    }
  }
  return { errors, warnings };
}

interface ServerRow {
  readonly server_version_num: number;
  readonly server_version: string;
  readonly database_name: string;
  readonly role_name: string;
  readonly is_superuser: boolean;
  readonly can_create_in_database: boolean;
}

interface ExtensionRow {
  readonly name: string;
  readonly available_version: string | null;
  readonly installed_version: string | null;
  readonly trusted: boolean | null;
}

export async function readPostgresServerSnapshot(
  sql: postgres.Sql,
): Promise<PostgresServerSnapshot> {
  const names = REQUIRED_POSTGRES_EXTENSIONS.map((extension) => extension.name);
  const servers = (await sql`
    select
      current_setting('server_version_num')::int as server_version_num,
      current_setting('server_version') as server_version,
      current_database() as database_name,
      current_user as role_name,
      coalesce((select rolsuper from pg_roles where rolname = current_user), false) as is_superuser,
      has_database_privilege(current_database(), 'CREATE') as can_create_in_database
  `) as unknown as readonly ServerRow[];
  const extensions = (await sql`
    select
      required.name,
      available.default_version as available_version,
      installed.extversion as installed_version,
      versions.trusted
    from unnest(${names}::text[]) as required(name)
    left join pg_available_extensions available on available.name = required.name
    left join pg_extension installed on installed.extname = required.name
    left join pg_available_extension_versions versions
      on versions.name = required.name and versions.version = available.default_version
  `) as unknown as readonly ExtensionRow[];
  const server = servers[0];
  if (server === undefined) {
    throw new Error("PostgreSQL returned no server metadata.");
  }
  return {
    serverVersionNum: server.server_version_num,
    serverVersion: server.server_version,
    databaseName: server.database_name,
    roleName: server.role_name,
    isSuperuser: server.is_superuser,
    canCreateInDatabase: server.can_create_in_database,
    extensions: extensions.map((row) => ({
      name: row.name,
      availableVersion: row.available_version,
      installedVersion: row.installed_version,
      trusted: row.trusted === true,
    })),
  };
}

/** Assert the server can run (migration) or serve (runtime) the Helix schema. */
export async function assertPostgresPrerequisites(
  sql: postgres.Sql,
  phase: PrerequisitePhase,
): Promise<PrerequisiteEvaluation> {
  const evaluation = evaluatePostgresPrerequisites(await readPostgresServerSnapshot(sql), phase);
  if (evaluation.errors.length > 0) {
    throw new PostgresPrerequisiteError(evaluation.errors);
  }
  return evaluation;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** Connection failures and "starting up" responses; never SQL or permission errors. */
export function isTransientPostgresConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code !== "string") {
    return false;
  }
  return TRANSIENT_NETWORK_CODES.has(code) || code === "57P03" || code.startsWith("08");
}

export interface WaitForPostgresOptions {
  readonly waitSeconds: number;
  readonly phase: PrerequisitePhase;
  readonly onRetry?: (error: unknown, remainingMs: number) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Wait up to `waitSeconds` for PostgreSQL to accept connections, then assert
 * the prerequisites once. Only connection failures are retried: a missing
 * extension or an old server is a configuration error that waiting cannot fix.
 */
export async function waitForPostgresPrerequisites(
  sql: postgres.Sql,
  options: WaitForPostgresOptions,
): Promise<PrerequisiteEvaluation> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const deadline = now() + Math.max(0, options.waitSeconds) * 1000;
  for (;;) {
    try {
      return await assertPostgresPrerequisites(sql, options.phase);
    } catch (error) {
      const remainingMs = deadline - now();
      if (!isTransientPostgresConnectionError(error) || remainingMs <= 0) {
        throw error;
      }
      options.onRetry?.(error, remainingMs);
      await sleep(Math.min(5000, remainingMs));
    }
  }
}
