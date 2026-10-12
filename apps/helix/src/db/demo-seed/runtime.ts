import type postgres from "postgres";
import { getBetterAuthRuntimeConfig } from "../../config/auth.js";
import { env as loadEnv, type Env } from "../../config/env.js";
import { PostgresDomainsStore } from "../../platform/admin/domains.js";
import { PostgresGroupsStore } from "../../platform/admin/groups.js";
import { PostgresSecurityPoliciesStore } from "../../platform/admin/security-policies.js";
import { PostgresAssistantStore } from "../../platform/assistant/store.js";
import { PostgresAssistantFeedbackStore } from "../../platform/assistant/message-annotations.js";
import { PostgresAuditStore } from "../../platform/audit/store.js";
import { PostgresAdminUsersStore } from "../../platform/auth/admin-users.js";
import { PostgresProfileStore } from "../../platform/auth/profile.js";
import { PostgresCalendarStore } from "../../platform/calendar/store.js";
import { PostgresContactsStore } from "../../platform/carddav/contacts-store.js";
import { PostgresChatAttachmentStore } from "../../platform/chat/attachments.js";
import { PostgresChatStore } from "../../platform/chat/store.js";
import { loadDriveConfig } from "../../platform/drive/config.js";
import { createClamAvVirusScanner, type VirusScanner } from "../../platform/drive/scanning.js";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import { PostgresDriveWorkflowStore } from "../../platform/drive/workflows.js";
import { ClamavScanner } from "../../platform/mail/antivirus.js";
import { PostgresMailAttachmentIngestor } from "../../platform/mail/attachment-ingestion.js";
import { mailConfig } from "../../platform/mail/config.js";
import { PostgresMailStore } from "../../platform/mail/store.js";
import { PostgresMeetStore } from "../../platform/meet/store.js";
import { PostgresNotificationStore } from "../../platform/notifications/store.js";
import {
  createS3CompatibleStorage,
  createTenantStorageResolver,
  type TenantStorageClient,
  type TenantStorageResolver,
} from "../../platform/storage/index.js";
import { TenantEnvelopeCipher, tenantSecretMasterKey } from "../../platform/secrets/envelope.js";
import { PostgresOrgStore } from "../../platform/tenancy/orgs.js";
import { withTenantPostgresContext } from "../../platform/tenancy/postgres-roles.js";
import { COMPANY } from "./company.js";
import { DemoTimeline } from "./random.js";
import type { DemoSize } from "./presets.js";
import type { DemoPreset } from "./presets.js";
import { ChronologyLedger } from "./chronology.js";

/** The real platform stores, built the way `bootstrap/` builds them for the API. */
export interface DemoRuntime {
  readonly sql: postgres.Sql;
  readonly env: Env;
  readonly orgId: string;
  readonly size: DemoSize;
  readonly preset: DemoPreset;
  readonly timeline: DemoTimeline;
  readonly chronology: ChronologyLedger;
  readonly rawStorage: TenantStorageClient & { ensureBucket(): Promise<void> };
  readonly storageResolver: TenantStorageResolver;
  readonly driveScanner: VirusScanner;
  readonly orgs: PostgresOrgStore;
  readonly drive: PostgresDriveStore;
  /** The unwrapped store, for worker passes that open their own tenant transactions. */
  readonly rawDrive: PostgresDriveStore;
  readonly driveWorkflows: PostgresDriveWorkflowStore;
  readonly mail: PostgresMailStore;
  /** The unwrapped store, for ingest paths that manage their own tenant transaction. */
  readonly rawMail: PostgresMailStore;
  readonly rawCalendar: PostgresCalendarStore;
  readonly mailIngestor: PostgresMailAttachmentIngestor;
  readonly mailScanner: ClamavScanner;
  readonly calendar: PostgresCalendarStore;
  readonly chat: PostgresChatStore;
  readonly chatAttachments: PostgresChatAttachmentStore;
  readonly contacts: PostgresContactsStore;
  readonly meet: PostgresMeetStore;
  readonly assistant: PostgresAssistantStore;
  readonly assistantFeedback: PostgresAssistantFeedbackStore;
  readonly groups: PostgresGroupsStore;
  readonly domains: PostgresDomainsStore;
  readonly profiles: PostgresProfileStore;
  readonly adminUsers: PostgresAdminUsersStore;
  readonly securityPolicies: PostgresSecurityPoliciesStore;
  readonly notifications: PostgresNotificationStore;
  readonly audit: PostgresAuditStore;
  /** The tenant envelope cipher the API uses for webhook and S3 key secrets. */
  readonly secretCipher: TenantEnvelopeCipher;
  readonly log: (phase: string, message: string) => void;
  /** Wraps a store so each call runs as an API request would (tenant + acting user). */
  readonly scoped: <T extends object>(store: T) => T;
  /** Runs `callback` inside the demo tenant's RLS context. */
  readonly tenant: <T>(
    callback: (tx: postgres.TransactionSql) => Promise<T>,
    actorId?: string,
  ) => Promise<T>;
}

/** The acting user of a store call: `input.actorId`, `input.actor.id` or an `Actor` argument. */
function callActor(args: readonly unknown[]): string | undefined {
  const [first] = args;
  if (typeof first !== "object" || first === null) return undefined;
  const record = first as {
    actorId?: unknown;
    actor?: { id?: unknown };
    id?: unknown;
    type?: unknown;
  };
  if (typeof record.actorId === "string") return record.actorId;
  if (typeof record.actor?.id === "string") return record.actor.id;
  if (typeof record.id === "string" && typeof record.type === "string") return record.id;
  return undefined;
}

/**
 * Every store call runs the way an API request does: inside one tenant
 * transaction with the acting user set, so RLS and actor-scoped policies apply.
 */
function requestScoped<T extends object>(
  sql: postgres.Sql,
  orgId: string,
  store: T,
  actorOf: (args: readonly unknown[]) => string | undefined = callActor,
): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const actorId = actorOf(args);
        return withTenantPostgresContext(
          sql,
          { orgId, ...(actorId === undefined ? {} : { actorId }) },
          () => Promise.resolve((value as (...inner: unknown[]) => unknown).apply(target, args)),
        );
      };
    },
  });
}

export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedError";
  }
}

export function createDemoRuntime(input: {
  readonly sql: postgres.Sql;
  readonly size: DemoSize;
  readonly preset: DemoPreset;
  readonly now: Date;
  readonly log: (phase: string, message: string) => void;
}): DemoRuntime {
  const env = loadEnv();
  const driveConfig = loadDriveConfig(env);
  const endpoint = driveConfig.storage.endpoint;
  if (endpoint === undefined) {
    throw new DemoSeedError(
      "Object storage is not configured. Set RUSTFS_ENDPOINT (for example http://127.0.0.1:28437) so Drive, Mail and Chat bytes have somewhere to live.",
    );
  }
  const serverSideEncryption = driveConfig.storage.serverSideEncryption;
  const rawStorage = createS3CompatibleStorage({
    endpoint,
    region: driveConfig.storage.region,
    bucket: driveConfig.storage.bucket,
    credentials: {
      accessKeyId: driveConfig.storage.accessKeyId,
      secretAccessKey: driveConfig.storage.secretAccessKey,
    },
    forcePathStyle: driveConfig.storage.forcePathStyle,
    ...(serverSideEncryption === undefined ? {} : { serverSideEncryption }),
    ...(driveConfig.storage.serverSideEncryptionAwsKmsKeyId === undefined
      ? {}
      : { serverSideEncryptionAwsKmsKeyId: driveConfig.storage.serverSideEncryptionAwsKmsKeyId }),
  });
  const orgs = new PostgresOrgStore(input.sql, env.HELIX_REGION);
  // Same resolver as the API: the tenant prefix comes from the org's storage config.
  const storageResolver = createTenantStorageResolver({
    defaultClient: rawStorage,
    ...(serverSideEncryption === undefined
      ? {}
      : { defaultServerSideEncryption: serverSideEncryption }),
    loadByoConfig: async (orgId) => (await orgs.findById(orgId))?.byoConfig,
  });
  const mailCfg = mailConfig(env);
  const scannerConfig = driveConfig.malwareScanner ?? mailCfg.clamav;
  if (scannerConfig === undefined) {
    throw new DemoSeedError(
      "Every seeded object is malware-scanned like a real upload, but no ClamAV scanner is configured. Set MAIL_CLAMAV_ENABLED=true with MAIL_CLAMAV_HOST/MAIL_CLAMAV_PORT (local stack: 127.0.0.1:28460).",
    );
  }
  const driveScanner = createClamAvVirusScanner({ ...scannerConfig, tier: "business" });
  const mailScanner = new ClamavScanner({ ...scannerConfig, tier: "business" });
  const attachmentIngestor = new PostgresMailAttachmentIngestor(input.sql, {
    storageResolver,
    scanner: mailScanner,
    scannerFailurePolicy: "reject",
  });
  const drive = new PostgresDriveStore(input.sql, rawStorage, {
    gc: driveConfig.gc,
    storageResolver,
    contentAddressedDedup: driveConfig.contentAddressedDedup,
    virusScanner: driveScanner,
    requireVirusScanner: true,
  });
  const orgId = COMPANY.orgId;
  const secretMaster = tenantSecretMasterKey({
    configuredKey: env.HELIX_SECRET_ENCRYPTION_KEY,
    betterAuthSecret: getBetterAuthRuntimeConfig(process.env)?.secret,
    production: env.NODE_ENV === "production",
  });
  if (secretMaster === undefined) {
    throw new DemoSeedError(
      "Set HELIX_SECRET_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) so seeded secrets match the API's cipher.",
    );
  }
  const rawMail = new PostgresMailStore(input.sql, { storageResolver, attachmentIngestor });
  const rawCalendar = new PostgresCalendarStore(input.sql);
  const scoped = <T extends object>(store: T): T => requestScoped(input.sql, orgId, store);
  // Directory writes name the member being changed; the acting user is the admin.
  const directoryAdmin = (args: readonly unknown[]) => {
    const first = args[0] as { createdBy?: unknown; addedBy?: unknown } | undefined;
    const actor = first?.createdBy ?? first?.addedBy;
    return typeof actor === "string" ? actor : undefined;
  };
  return {
    sql: input.sql,
    env,
    orgId,
    size: input.size,
    preset: input.preset,
    timeline: new DemoTimeline(input.now, input.preset.historyDays),
    chronology: new ChronologyLedger(),
    rawStorage,
    storageResolver,
    driveScanner,
    orgs,
    drive: scoped(drive),
    rawDrive: drive,
    driveWorkflows: scoped(new PostgresDriveWorkflowStore(input.sql)),
    mail: scoped(rawMail),
    rawMail,
    rawCalendar,
    mailIngestor: attachmentIngestor,
    mailScanner,
    calendar: scoped(rawCalendar),
    chat: scoped(new PostgresChatStore(input.sql)),
    chatAttachments: scoped(
      new PostgresChatAttachmentStore(input.sql, {
        storageResolver,
        virusScanner: driveScanner,
        driveStore: drive,
      }),
    ),
    contacts: scoped(new PostgresContactsStore(input.sql)),
    meet: scoped(new PostgresMeetStore(input.sql)),
    assistant: scoped(new PostgresAssistantStore(input.sql)),
    assistantFeedback: scoped(new PostgresAssistantFeedbackStore(input.sql)),
    groups: requestScoped(input.sql, orgId, new PostgresGroupsStore(input.sql), directoryAdmin),
    domains: scoped(new PostgresDomainsStore(input.sql)),
    profiles: scoped(new PostgresProfileStore(input.sql)),
    adminUsers: new PostgresAdminUsersStore(input.sql),
    securityPolicies: scoped(new PostgresSecurityPoliciesStore(input.sql)),
    notifications: scoped(new PostgresNotificationStore(input.sql)),
    audit: new PostgresAuditStore(input.sql),
    secretCipher: new TenantEnvelopeCipher(secretMaster),
    log: input.log,
    scoped,
    tenant: (callback, actorId) =>
      withTenantPostgresContext(
        input.sql,
        { orgId, ...(actorId === undefined ? {} : { actorId }) },
        callback,
      ),
  };
}
