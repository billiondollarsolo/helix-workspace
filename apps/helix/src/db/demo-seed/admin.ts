import type { Actor } from "@helix/sdk-types";
import { PostgresOAuthAppsStore } from "../../platform/admin/oauth-apps.js";
import { PostgresActorOffboardingStore } from "../../platform/auth/actor-offboarding.js";
import { AppPasswordManager, PostgresAppPasswordStore } from "../../platform/auth/app-passwords.js";
import { hashApiKey } from "../../platform/auth/credentials.js";
import { hashSecret } from "../../platform/auth/oauth.js";
import { PostgresAgentCredentialStore } from "../../platform/auth/postgres-store.js";
import { getCryptoProvider } from "../../platform/crypto/index.js";
import { PostgresDriveS3AccessKeyStore } from "../../platform/drive/s3/access-keys.js";
import { PostgresGovernanceStore } from "../../platform/governance/ediscovery.js";
import { signWebhookPayload } from "../../platform/webhooks/signatures.js";
import { PostgresWebhookStore } from "../../platform/webhooks/store.js";
import type { WebhookDeliveryStatus } from "../../platform/webhooks/types.js";
import { DEFAULT_LOCAL_OAUTH_SCOPES, seedLocalOAuth } from "../seed-local-oauth.js";
import { activePeople, COMPANY, loginPerson, personByKey, type Person } from "./company.js";
import { ADMIN_SCOPES, type Directory } from "./directory.js";
import { SeedRandom, seedUuid, TIME } from "./random.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";

export interface AdminSeed {
  readonly appPasswords: number;
  readonly s3Keys: number;
  readonly oauthApps: number;
  readonly serviceAccounts: number;
  readonly agentCredentials: number;
  readonly webhooks: number;
  readonly webhookDeliveries: number;
  readonly policies: number;
  readonly retentionPolicies: number;
  readonly legalHolds: number;
  readonly notifications: number;
}

function adminActor(runtime: DemoRuntime, directory: Directory): Actor {
  const admin = loginPerson(directory.people, "admin");
  return { id: admin.actorId, orgId: runtime.orgId, type: "user", email: admin.email };
}

function secret(prefix: string): string {
  return `${prefix}${getCryptoProvider().randomBytes(24).toString("base64url")}`;
}

/** Security and data-handling policies an IT team would have tuned by now. */
async function seedPolicies(runtime: DemoRuntime, admin: Actor): Promise<number> {
  const policies = [
    // The API refuses to require MFA before the admin has a factor; the demo admin has none.
    {
      policyType: "mfa",
      enforcement: "optional",
      settings: {
        adminMfa: "optional",
        allowedMethods: ["hardware_key", "totp"],
        rememberDeviceDays: 14,
      },
    },
    {
      policyType: "session",
      enforcement: "required",
      settings: { inactivityTimeoutDays: 14, absoluteLifetimeDays: 30, maxConcurrentSessions: 8 },
    },
    {
      policyType: "external_sharing",
      enforcement: "required",
      settings: {
        mode: "allowlist",
        allowedDomains: ["northwind-freight.example", "harborline.example"],
        requireExpiry: true,
      },
    },
    {
      policyType: "dlp",
      enforcement: "optional",
      settings: { detectors: ["pii", "credentials", "credit_card"], action: "warn" },
    },
  ] as const;
  for (const policy of policies) {
    await runtime.securityPolicies.upsert({
      orgId: runtime.orgId,
      enabled: true,
      updatedBy: admin.id,
      ...policy,
      settings: { ...policy.settings },
    });
  }
  return policies.length;
}

/** Long-lived access people set up for desktop mail clients, CalDAV and S3 tools. */
async function seedPersonalCredentials(runtime: DemoRuntime, people: readonly Person[]) {
  const appPasswords = new AppPasswordManager(
    runtime.scoped(new PostgresAppPasswordStore(runtime.sql)),
  );
  const s3Keys = runtime.scoped(
    new PostgresDriveS3AccessKeyStore(runtime.sql, runtime.secretCipher),
  );
  let passwords = 0;
  let keys = 0;
  for (const person of people) {
    const random = SeedRandom.stream("credentials", person.key);
    const wantsMail = person.login !== null || random.chance(0.12);
    if (wantsMail) {
      const created = await appPasswords.create({
        orgId: runtime.orgId,
        actorId: person.actorId,
        label: random.pick([
          "Thunderbird on laptop",
          "iPhone Mail",
          "Apple Calendar",
          "Outlook desktop",
        ]),
        scopes: ["mail.read", "mail.send", "smtp", "calendar.read", "caldav"],
      });
      const at = runtime.timeline.recentWorkday(random, 300);
      runtime.chronology.at(
        "app_passwords",
        { id: created.appPassword.id },
        { created_at: at, last_used_at: runtime.timeline.recentWorkday(random, 3) },
      );
      passwords += 1;
    }
    if (person.login !== null || (person.department === "engineering" && random.chance(0.15))) {
      const created = await s3Keys.create({
        orgId: runtime.orgId,
        actorId: person.actorId,
        label: random.pick(["rclone backup", "CI artifacts", "Cyberduck"]),
        scopes:
          person.login === "admin"
            ? ["drive.read", "drive.write", "drive.delete"]
            : ["drive.read", "drive.write"],
        expiresAt: new Date(runtime.timeline.now.getTime() + 180 * TIME.DAY),
      });
      runtime.chronology.at(
        "drive_s3_access_keys",
        { id: created.accessKey.id },
        {
          created_at: runtime.timeline.recentWorkday(random, 200),
          last_used_at: runtime.timeline.recentWorkday(random, 10),
        },
      );
      keys += 1;
    }
  }
  return { passwords, keys };
}

const OAUTH_APPS = [
  {
    name: "Ledgerline Expenses",
    publisher: "Ledgerline Inc.",
    scopes: ["mail.read", "drive.read"],
    scopeSummary: "Reads receipts from mail and Drive",
    risk: "medium",
    status: "approved",
    userCount: 34,
  },
  {
    name: "Pulsecheck Surveys",
    publisher: "Pulsecheck",
    scopes: ["profile.read"],
    scopeSummary: "Basic profile",
    risk: "low",
    status: "approved",
    userCount: 71,
  },
  {
    name: "Tidewater CRM",
    publisher: "Tidewater Software",
    scopes: ["mail.read", "mail.send", "calendar.read", "contacts.read"],
    scopeSummary: "Logs customer mail and meetings",
    risk: "high",
    status: "approved",
    userCount: 18,
  },
  {
    name: "Quickslide Converter",
    publisher: "Unknown publisher",
    scopes: ["drive.read", "drive.write"],
    scopeSummary: "Full Drive access",
    risk: "high",
    status: "blocked",
    userCount: 3,
  },
  {
    name: "Standup Bot",
    publisher: "Brightpath Tools",
    scopes: ["chat.read", "chat.post"],
    scopeSummary: "Posts in Chat spaces",
    risk: "medium",
    status: "pending",
    userCount: 0,
  },
  {
    name: "Calendly-style Scheduler",
    publisher: "Slotwise",
    scopes: ["calendar.read:freebusy", "calendar.write"],
    scopeSummary: "Books meetings on your calendar",
    risk: "medium",
    status: "revoked",
    userCount: 0,
  },
] as const;

async function seedOAuthApps(runtime: DemoRuntime, admin: Actor): Promise<number> {
  const store = runtime.scoped(new PostgresOAuthAppsStore(runtime.sql));
  const random = SeedRandom.stream("oauth-apps");
  for (const [index, app] of OAUTH_APPS.entries()) {
    const created = await store.create({
      orgId: runtime.orgId,
      clientId: `qf-${String(index + 1).padStart(3, "0")}-${app.name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      ...app,
      scopes: [...app.scopes],
      status: app.status === "approved" ? "pending" : app.status,
    });
    if (app.status === "approved") {
      await store.setStatus({
        orgId: runtime.orgId,
        id: created.id,
        status: "approved",
        reviewedBy: admin.id,
      });
    }
    const at = runtime.timeline.recentWorkday(random, 500);
    runtime.chronology.at(
      "admin_oauth_apps",
      { id: created.id },
      { created_at: at, updated_at: runtime.timeline.after(at, random, 30, 20 * 1440) },
    );
  }
  return OAUTH_APPS.length;
}

const SERVICE_ACCOUNTS = [
  {
    key: "deploy-bot",
    name: "Waypoint deploy bot",
    purpose: "Posts release notes and uploads build artifacts",
    type: "api_key",
    scopes: ["chat.read", "chat.post", "drive.read", "drive.write"],
  },
  {
    key: "support-triage",
    name: "Support triage agent",
    purpose: "Labels and routes support@ mail",
    type: "oauth_client",
    scopes: ["mail.read", "mail.write", "tools:read"],
  },
  {
    key: "finance-export",
    name: "Finance exports",
    purpose: "Nightly export of invoices to the ledger",
    type: "api_key",
    scopes: ["drive.read", "mail.read"],
  },
] as const;

/** Non-human principals with credentials issued by the workspace admin. */
async function seedServiceAccounts(runtime: DemoRuntime, admin: Actor) {
  const store = new PostgresAgentCredentialStore(runtime.sql);
  const random = SeedRandom.stream("service-accounts");
  for (const account of SERVICE_ACCOUNTS) {
    const id = seedUuid("service-account", account.key);
    await runtime.tenant(async (tx) => {
      await tx`
        insert into actors (id, org_id, type, email, display_name, scopes, metadata)
        values (${id}, ${runtime.orgId}, 'service_account', ${`${account.key}@${COMPANY.domain}`},
          ${account.name}, ${tx.array([...account.scopes], 1009)}, ${tx.json({ ownerActorId: admin.id, purpose: account.purpose })})
      `;
    }, admin.id);
    const expiresAt = new Date(runtime.timeline.now.getTime() + 240 * TIME.DAY);
    const credential = await store.issue({
      orgId: runtime.orgId,
      operatorActorId: admin.id,
      principalActorId: id,
      credentialType: account.type,
      label: `${account.name} (${account.type === "api_key" ? "API key" : "OAuth client"})`,
      purpose: account.purpose,
      scopes: [...account.scopes],
      expiresAt,
      ...(account.type === "api_key"
        ? { apiKeyHash: hashApiKey(secret("helix_ak_")) }
        : { clientId: `qf-${account.key}`, secretHash: await hashSecret(secret("helix_cs_")) }),
    });
    const at = runtime.timeline.recentWorkday(random, 240);
    runtime.chronology.at("actors", { id }, { created_at: at, updated_at: at });
    runtime.chronology.at(
      "agent_credentials",
      { id: credential.id },
      { created_at: at, updated_at: at, last_used_at: runtime.timeline.recentWorkday(random, 2) },
    );
  }
  return { serviceAccounts: SERVICE_ACCOUNTS.length, credentials: SERVICE_ACCOUNTS.length };
}

const WEBHOOKS = [
  {
    name: "HR system sync",
    url: "https://hooks.peoplefirst-hr.example/helix",
    subjects: ["activity.admin.user.>"],
    enabled: true,
    failureRate: 0.04,
  },
  {
    name: "Security incident pager",
    url: "https://events.pagerline.example/v2/helix",
    subjects: ["activity.security.alert.>"],
    enabled: true,
    failureRate: 0.1,
  },
  {
    name: "Data warehouse export (paused)",
    url: "https://ingest.lakehouse.example/webhooks/quillfeather",
    subjects: ["activity.drive.>", "activity.mail.>"],
    enabled: false,
    failureRate: 0.35,
  },
] as const;

/** Outbound webhooks with a believable delivery log: mostly 2xx, some retries and failures. */
async function seedWebhooks(runtime: DemoRuntime, admin: Actor) {
  const store = new PostgresWebhookStore(runtime.sql, runtime.secretCipher);
  let deliveries = 0;
  for (const spec of WEBHOOKS) {
    const random = SeedRandom.stream("webhooks", spec.name);
    const signingSecret = secret("whsec_");
    const webhook = await runtime.tenant(() =>
      store.createOutbound({
        orgId: runtime.orgId,
        name: spec.name,
        url: spec.url,
        eventSubjects: [...spec.subjects],
        secret: signingSecret,
        enabled: spec.enabled,
        createdByActorId: admin.id,
      }),
    );
    const created = runtime.timeline.daysAgo(random.int(120, 400));
    runtime.chronology.at(
      "outbound_webhooks",
      { id: webhook.id },
      { created_at: created, updated_at: runtime.timeline.after(created, random, 30, 60 * 1440) },
    );
    const count = runtime.preset.webhookDeliveries;
    for (let index = 0; index < count; index += 1) {
      const at = runtime.timeline.after(
        created,
        random,
        30,
        Math.floor((runtime.timeline.now.getTime() - created.getTime()) / TIME.MINUTE),
      );
      const subject = spec.subjects[0].replace(
        ">",
        random.pick(["created", "updated", "suspended"]),
      );
      const payload = {
        subject,
        orgId: runtime.orgId,
        occurredAt: at.toISOString(),
        data: { id: seedUuid("webhook-event", spec.name, index) },
      };
      const failed = random.chance(spec.failureRate);
      const status: WebhookDeliveryStatus = failed
        ? random.chance(0.5)
          ? "abandoned"
          : "failed"
        : "delivered";
      const signature = signWebhookPayload({
        payload: JSON.stringify(payload),
        secret: signingSecret,
        timestamp: at,
      });
      const delivery = await runtime.tenant(() =>
        store.createDelivery({
          orgId: runtime.orgId,
          direction: "outbound",
          outboundWebhookId: webhook.id,
          eventSubject: subject,
          status,
          attempt: failed
            ? status === "abandoned"
              ? 8
              : random.int(2, 5)
            : random.chance(0.1)
              ? 2
              : 1,
          payload,
          signature: signature.header,
          requestHeaders: {
            "content-type": "application/json",
            "helix-signature": signature.header,
          },
          responseStatus: failed
            ? random.pick([500, 502, 503, 504])
            : random.pick([200, 200, 202, 204]),
          responseHeaders: { "content-type": "application/json" },
          error: failed
            ? random.pick([
                "Upstream returned 503 Service Unavailable",
                "Timed out after 10s",
                "Upstream returned 502 Bad Gateway",
              ])
            : null,
          deliveredAt: failed ? null : new Date(at.getTime() + random.int(80, 900)),
        }),
      );
      runtime.chronology.at(
        "webhook_deliveries",
        { id: delivery.id },
        {
          created_at: at,
          updated_at: new Date(at.getTime() + TIME.MINUTE),
          ...(failed ? {} : { delivered_at: new Date(at.getTime() + random.int(80, 900)) }),
        },
      );
      deliveries += 1;
    }
  }
  return { webhooks: WEBHOOKS.length, deliveries };
}

/** Retention schedules plus one open legal matter with a hold, as Legal would keep. */
async function seedGovernance(runtime: DemoRuntime, admin: Actor, directory: Directory) {
  const store = new PostgresGovernanceStore(runtime.sql, runtime.storageResolver);
  const base = { orgId: runtime.orgId, actorId: admin.id };
  const policies = [
    { name: "Default seven-year retention", product: "all", retentionDays: 2555 },
    { name: "Chat: two years", product: "chat", retentionDays: 730 },
    { name: "Meeting recordings: one year", product: "recording", retentionDays: 365 },
  ] as const;
  for (const policy of policies)
    await store.setRetentionPolicy({ ...base, ...policy, enabled: true });
  const legal = directory.people.find(
    (person) => person.department === "legal" && person.status === "active",
  );
  const custodian = directory.people.find(
    (person) => person.department === "sales" && person.status === "active",
  );
  let holds = 0;
  if (legal !== undefined && custodian !== undefined) {
    const matter = await store.createMatter({
      orgId: runtime.orgId,
      actorId: legal.actorId,
      name: "Harborline contract dispute",
      description: "Preserve correspondence about the 2025 Harborline renewal.",
    });
    await store.addCustodian({
      orgId: runtime.orgId,
      actorId: legal.actorId,
      matterId: matter.id,
      custodianActorId: custodian.actorId,
    });
    await store.createHold({
      orgId: runtime.orgId,
      actorId: legal.actorId,
      matterId: matter.id,
      product: "mail",
      reason: "Renewal negotiation correspondence",
    });
    holds += 1;
  }
  return { policies: policies.length, holds };
}

const NOTIFICATIONS = [
  {
    verb: "drive.shared",
    objectType: "drive_file",
    summary: "Jordan shared “Q3 board deck” with you",
  },
  {
    verb: "chat.mentioned",
    objectType: "chat_message",
    summary: "You were mentioned in #waypoint-5-launch",
  },
  {
    verb: "calendar.invited",
    objectType: "calendar_event",
    summary: "New invitation: Customer advisory board",
  },
  {
    verb: "drive.commented",
    objectType: "drive_file",
    summary: "New comment on “Pricing proposal”",
  },
  {
    verb: "admin.security.alert",
    objectType: "security_alert",
    summary: "Sign-in from a new device was blocked",
  },
] as const;

async function seedNotifications(runtime: DemoRuntime, people: readonly Person[]): Promise<number> {
  let count = 0;
  for (const person of people.filter((candidate) => candidate.login !== null)) {
    const random = SeedRandom.stream("notifications", person.key);
    const records = await runtime.notifications.insertMany(
      NOTIFICATIONS.filter(
        (item) => person.login === "admin" || item.verb !== "admin.security.alert",
      ).map((item) => ({
        orgId: runtime.orgId,
        actorId: person.actorId,
        verb: item.verb,
        objectType: item.objectType,
        summary: item.summary,
      })),
    );
    for (const [index, record] of records.entries()) {
      const at = runtime.timeline.recentWorkday(random, 6);
      runtime.chronology.at(
        "notifications",
        { id: record.id },
        {
          created_at: at,
          ...(index > 1 ? { read_at: runtime.timeline.after(at, random, 30, 1 * 1440) } : {}),
        },
      );
      count += 1;
    }
  }
  return count;
}

export async function seedAdmin(runtime: DemoRuntime, directory: Directory): Promise<AdminSeed> {
  const admin = adminActor(runtime, directory);
  const people = activePeople(directory.people);
  const policies = await seedPolicies(runtime, admin);
  const personal = await seedPersonalCredentials(runtime, people);
  const oauthApps = await seedOAuthApps(runtime, admin);
  const services = await seedServiceAccounts(runtime, admin);
  // The local OAuth client acts as the workspace admin, so API and MCP smokes see real content.
  const adminPerson = loginPerson(directory.people, "admin");
  await seedLocalOAuth(runtime.sql, {
    orgId: runtime.orgId,
    actorId: adminPerson.actorId,
    email: adminPerson.email,
    displayName: adminPerson.displayName,
    scopes: [...new Set([...ADMIN_SCOPES, ...DEFAULT_LOCAL_OAUTH_SCOPES])],
  });
  const webhooks = await seedWebhooks(runtime, admin);
  const governance = await seedGovernance(runtime, admin, directory);
  const notifications = await seedNotifications(runtime, people);
  return {
    appPasswords: personal.passwords,
    s3Keys: personal.keys,
    oauthApps,
    serviceAccounts: services.serviceAccounts,
    agentCredentials: services.credentials,
    webhooks: webhooks.webhooks,
    webhookDeliveries: webhooks.deliveries,
    policies,
    retentionPolicies: governance.policies,
    legalHolds: governance.holds,
    notifications,
  };
}

/**
 * Former and suspended employees, retired through the admin console's
 * lifecycle functions: offboarding hands their Drive, mail and calendars to
 * their manager; suspension keeps everything but blocks sign-in.
 */
export async function seedAccountLifecycle(runtime: DemoRuntime, directory: Directory) {
  const admin = adminActor(runtime, directory);
  const offboarding = new PostgresActorOffboardingStore(runtime.sql);
  let offboarded = 0;
  let suspended = 0;
  for (const person of directory.people) {
    if (person.status === "offboarded") {
      const successor =
        person.managerKey === null ? undefined : personByKey(directory.people, person.managerKey);
      const input = {
        actorId: person.actorId,
        ...(successor === undefined ? {} : { successorActorId: successor.actorId }),
      };
      const preview = await offboarding.preview(admin, input);
      if (preview.blockers.length > 0) {
        throw new DemoSeedError(`Cannot offboard ${person.email}: ${preview.blockers.join("; ")}`);
      }
      await offboarding.offboard(admin, { ...input, confirmationToken: preview.confirmationToken });
      offboarded += 1;
    } else if (person.status === "suspended") {
      await runtime.adminUsers.setSuspended(admin, person.actorId, true);
      suspended += 1;
    }
  }
  return { offboarded, suspended };
}
