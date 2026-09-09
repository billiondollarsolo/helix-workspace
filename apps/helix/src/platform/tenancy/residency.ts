import type postgres from "postgres";
import type { AiConfig, JsonObject } from "@helix/sdk-types";

const regionPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface DeploymentResidencyInput {
  readonly region: string;
  readonly storageRegion: string;
  readonly production?: boolean;
  readonly storageKmsKeyId?: string | undefined;
  readonly mailKmsKeyId?: string | undefined;
  readonly mailKmsRegion?: string | undefined;
  readonly searchIndexUid?: string | undefined;
  readonly ollamaUrl?: string | undefined;
  readonly openAiApiKey?: string | undefined;
  readonly telemetryEnabled?: boolean | undefined;
  readonly telemetryRegion?: string | undefined;
  readonly auditRegion?: string | undefined;
  readonly siemEnabled?: boolean | undefined;
  readonly siemRegion?: string | undefined;
  readonly meetConfigured?: boolean | undefined;
  readonly meetRegion?: string | undefined;
  readonly ai?: AiConfig | undefined;
}

/**
 * One regional deployment owns one regional database and every derivative it
 * produces. Refuse startup when a configured processor points elsewhere.
 */
export function assertDeploymentResidency(input: DeploymentResidencyInput): void {
  assertRegionName(input.region, "HELIX_REGION");
  if (input.production === true && input.region === "default") {
    throw new Error("Production requires an explicit non-default HELIX_REGION.");
  }
  if (input.production !== true && input.region === "default") return;
  assertSameRegion(input.region, input.storageRegion, "object storage");
  assertKmsRegion(input.storageKmsKeyId, input.region, "object storage KMS key");
  if (input.mailKmsKeyId !== undefined) {
    assertSameRegion(input.region, input.mailKmsRegion, "mail DKIM KMS key");
    assertKmsRegion(input.mailKmsKeyId, input.region, "mail DKIM KMS key");
  }

  const index = input.searchIndexUid;
  if (index !== undefined && !index.startsWith(`${input.region}_`)) {
    throw new Error(`Search index must start with '${input.region}_'.`);
  }
  assertRegionalInternalUrl(input.ollamaUrl, "Ollama");

  if (input.production === true && input.openAiApiKey !== undefined) {
    throw new Error(
      "OPENAI_API_KEY has no residency declaration; configure a region-pinned AI provider instead.",
    );
  }
  assertAiResidency(input.ai, input.region);

  if (input.telemetryEnabled === true) {
    assertSameRegion(input.region, input.telemetryRegion, "telemetry collector");
  }
  if (input.auditRegion !== undefined) {
    assertSameRegion(input.region, input.auditRegion, "immutable audit storage");
  }
  if (input.siemEnabled === true) {
    assertSameRegion(input.region, input.siemRegion, "SIEM");
  }
  if (input.meetConfigured === true) {
    assertSameRegion(input.region, input.meetRegion, "Meet media");
  }
}

/** Fail boot if this physical database contains tenants assigned elsewhere. */
export async function assertRegionalDatabase(sql: postgres.Sql, region: string): Promise<void> {
  const rows = await sql<{ readonly region: string; readonly tenant_count: number }[]>`
    select region, count(*)::integer as tenant_count
    from orgs
    where region <> ${region}
    group by region
    order by region
  `;
  if (rows.length > 0) {
    throw new Error(
      `Regional database '${region}' contains tenants assigned to: ${rows
        .map((row) => `${row.region} (${String(row.tenant_count)})`)
        .join(", ")}.`,
    );
  }
}

export function assertTenantRegion(actual: string, expected: string): void {
  assertSameRegion(expected, actual, "tenant");
}

export function regionalResourceName(region: string, name: string): string {
  assertRegionName(region, "region");
  return `${region}_${name}`;
}

export function assertStorageRegion(region: string, expected: string): void {
  assertSameRegion(expected, region, "tenant object storage");
}

function assertRegionName(region: string, name: string): void {
  if (!regionPattern.test(region)) {
    throw new Error(`${name} must be a canonical lowercase region identifier.`);
  }
}

function assertSameRegion(expected: string, actual: string | undefined, system: string): void {
  if (actual !== expected) {
    throw new Error(
      `${system} region '${actual ?? "unset"}' does not match deployment region '${expected}'.`,
    );
  }
}

function assertKmsRegion(keyId: string | undefined, region: string, system: string): void {
  if (keyId === undefined || !keyId.startsWith("arn:")) return;
  const arnRegion = keyId.split(":")[3];
  if (arnRegion !== region) {
    throw new Error(`${system} ARN is outside deployment region '${region}'.`);
  }
}

function assertRegionalInternalUrl(value: string | undefined, system: string): void {
  if (value === undefined) return;
  const hostname = new URL(value).hostname.toLowerCase();
  if (
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1" &&
    hostname.includes(".") &&
    !hostname.endsWith(".svc") &&
    !hostname.endsWith(".svc.cluster.local")
  ) {
    throw new Error(`${system} must use a regional in-cluster endpoint.`);
  }
}

function assertAiResidency(ai: AiConfig | undefined, region: string): void {
  if (ai?.enabled === false) return;
  for (const provider of ai?.providers ?? []) {
    if (provider.enabled !== false) assertAiPlugin(provider.plugin, provider.config, region);
  }
  for (const plugin of [ai?.embeddingProvider, ai?.vectorStore]) {
    if (plugin !== undefined) assertAiPlugin(plugin.plugin, plugin.config, region);
  }
}

function assertAiPlugin(plugin: string, config: JsonObject | undefined, region: string): void {
  const localUrl = typeof config?.baseUrl === "string" ? config.baseUrl : undefined;
  if (localUrl !== undefined) {
    try {
      assertRegionalInternalUrl(localUrl, `AI plugin '${plugin}'`);
      return;
    } catch {
      // External endpoints still pass when they carry an exact placement declaration.
    }
  }
  const configuredRegion =
    typeof config?.region === "string"
      ? config.region
      : typeof config?.location === "string"
        ? config.location
        : undefined;
  assertSameRegion(region, configuredRegion, `AI plugin '${plugin}'`);
}
