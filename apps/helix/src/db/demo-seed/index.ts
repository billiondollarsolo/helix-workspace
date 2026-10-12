import type postgres from "postgres";
import { createSearchEngine } from "../../bootstrap/search.js";
import { assertTenantSafeDatabaseRole } from "../client.js";
import { buildRoster, COMPANY, loginPerson } from "./company.js";
import { DemoDns } from "./dns.js";
import { seedAliases, seedOrgStructure, seedPeople, type Directory } from "./directory.js";
import { seedAccountLifecycle, seedAdmin } from "./admin.js";
import { seedAssistant } from "./assistant.js";
import { seedCalendar } from "./calendar.js";
import { seedContacts } from "./contacts.js";
import { seedChat } from "./chat.js";
import { seedDrive } from "./drive.js";
import { alignMailTimeline, seedMail } from "./mail.js";
import { DEMO_PRESETS, type DemoSize } from "./presets.js";
import { resetDemoTenant } from "./reset.js";
import { createDemoRuntime, DemoSeedError } from "./runtime.js";
import {
  createDemoTenant,
  DEMO_SEED_VERSION,
  readDemoMarker,
  verifyDemoDomains,
  writeDemoMarker,
  type DemoSeedMarker,
} from "./tenant.js";
import { validateDemo, type DemoValidation } from "./validate.js";

export interface DemoSeedOptions {
  readonly size: DemoSize;
  readonly reset: boolean;
  readonly accountsOnly: boolean;
  readonly now: Date;
}

export interface DemoSeedSummary {
  readonly orgId: string;
  readonly size: DemoSize;
  readonly mode: "full" | "accounts";
  readonly seeded: boolean;
  readonly seconds: number;
  readonly phases: readonly {
    readonly name: string;
    readonly seconds: number;
    readonly detail: string;
  }[];
  readonly logins: readonly {
    readonly email: string;
    readonly password: string;
    readonly role: string;
  }[];
  readonly validation: DemoValidation;
}

type Logger = (message: string) => void;

/**
 * Application writes go through the RLS-bound runtime role, exactly as the API
 * runs in production; only the reset uses the owner connection.
 */
async function assertRuntimeRole(sql: postgres.Sql): Promise<void> {
  try {
    await assertTenantSafeDatabaseRole(sql);
  } catch (error) {
    throw new DemoSeedError(
      `${error instanceof Error ? error.message : String(error)} The demo seed writes as the application runtime role, like the API in production: set DATABASE_URL to it (local stack: postgres://helix_app:helix_app_local@127.0.0.1:28432/helix) and HELIX_MIGRATION_DATABASE_URL to the owner.`,
    );
  }
}

/**
 * Seeds (or, when already seeded, re-validates) the Quillfeather Labs demo
 * tenant. Content goes through the platform stores; nothing here writes rows
 * that the application could not have written itself.
 */
export async function seedDemo(input: {
  readonly sql: postgres.Sql;
  readonly privilegedSql: postgres.Sql;
  readonly options: DemoSeedOptions;
  readonly log: Logger;
}): Promise<DemoSeedSummary> {
  const started = Date.now();
  await assertRuntimeRole(input.sql);
  const preset = DEMO_PRESETS[input.options.size];
  const mode = input.options.accountsOnly ? "accounts" : "full";
  const phases: { name: string; seconds: number; detail: string }[] = [];
  const runtime = createDemoRuntime({
    sql: input.sql,
    size: input.options.size,
    preset,
    now: input.options.now,
    log: (phase, message) => {
      input.log(`[${phase}] ${message}`);
    },
  });
  const roster = buildRoster(preset.headcount);
  const logins = roster
    .filter((person) => person.login !== null || person.index < 3)
    .map((person) => ({
      email: person.email,
      password: person.password,
      role: person.login === "admin" ? "workspace admin" : person.jobTitle,
    }));
  const existing = await readDemoMarker(runtime);
  const reusable =
    existing.marker !== null &&
    existing.marker.state === "complete" &&
    existing.marker.version === DEMO_SEED_VERSION &&
    existing.marker.size === input.options.size &&
    existing.marker.mode === mode;
  if (existing.exists && !input.options.reset && !reusable) {
    if (existing.marker === null) {
      throw new DemoSeedError(
        `Organization ${runtime.orgId} already exists but was not created by the demo seed. Re-run with --reset to replace it (this deletes all of its data).`,
      );
    }
    if (existing.marker.state === "complete") {
      throw new DemoSeedError(
        `The demo tenant was seeded as ${existing.marker.mode}/${existing.marker.size} (version ${String(existing.marker.version)}). Re-run with --reset to seed ${mode}/${input.options.size}.`,
      );
    }
    input.log("a previous demo seed did not finish; resetting before seeding again");
  }
  const search = await createSearchEngine(runtime.env.HELIX_REGION);
  if (reusable && !input.options.reset) {
    input.log(`demo tenant already seeded (${mode}/${input.options.size}); validating it`);
    const validation = await validateDemo(runtime, roster, { full: mode === "full", search });
    return {
      orgId: runtime.orgId,
      size: input.options.size,
      mode,
      seeded: false,
      seconds: (Date.now() - started) / 1000,
      phases,
      logins,
      validation,
    };
  }
  if (existing.exists) {
    await resetDemoTenant({
      privilegedSql: input.privilegedSql,
      orgId: runtime.orgId,
      storageResolver: runtime.storageResolver,
      search,
      log: (message) => {
        input.log(`[reset] ${message}`);
      },
    });
  }

  const phase = async (name: string, run: () => Promise<string>) => {
    const phaseStarted = Date.now();
    input.log(`[${name}] started`);
    const detail = await run();
    const seconds = (Date.now() - phaseStarted) / 1000;
    phases.push({ name, seconds, detail });
    input.log(`[${name}] ${detail} (${seconds.toFixed(1)}s)`);
  };

  const dns = new DemoDns();
  const admin = loginPerson(roster, "admin");
  const marker = (state: DemoSeedMarker["state"]): DemoSeedMarker => ({
    version: DEMO_SEED_VERSION,
    size: input.options.size,
    mode,
    state,
    anchor: input.options.now.toISOString(),
  });
  let directory: Directory | undefined;
  await phase("tenant", async () => {
    await createDemoTenant(runtime);
    await writeDemoMarker(runtime, marker("seeding"));
    return `${COMPANY.name} (${runtime.orgId}) with storage prefix tenants/${runtime.orgId}/`;
  });
  await phase("people", async () => {
    await seedPeople(runtime, roster);
    return `${String(roster.length)} people with sign-in, profile photo and working hours`;
  });
  await phase("domains", async () => {
    await verifyDemoDomains(runtime, dns, admin.actorId);
    await seedAliases(runtime, roster);
    return `${COMPANY.domain} and ${COMPANY.loginDomain} verified for identity and mail`;
  });
  await phase("groups", async () => {
    const groups = await seedOrgStructure(runtime, roster, admin.actorId);
    directory = {
      people: roster,
      byKey: new Map(roster.map((person) => [person.key, person])),
      groups,
    };
    return `${String(groups.size)} groups and distribution lists`;
  });
  if (directory === undefined) throw new DemoSeedError("Directory phase did not complete.");
  const people = directory;
  if (mode === "full") {
    await phase("drive", async () => {
      const drive = await seedDrive(runtime, people);
      return `${String(drive.files.length)} files (${(drive.bytes / 1_048_576).toFixed(1)} MiB) in ${String(drive.folders)} folders, ${String(drive.versions)} extra versions, ${String(drive.comments)} comments, ${String(drive.shareLinks)} public links, ${String(drive.trashed)} in trash`;
    });
    await phase("mail", async () => {
      const mail = await seedMail(runtime, people, dns);
      return `${String(mail.internalMessages)} internal messages in ${String(mail.internalThreads)} conversations, ${String(mail.inboundMessages)} external messages, ${String(mail.mailboxThreads)} mailbox threads, ${String(mail.labels)} labels, ${String(mail.filters)} filters, ${String(mail.drafts)} drafts, ${String(mail.scheduled)} scheduled, ${String(mail.spam)} reported as spam`;
    });
    await phase("chat", async () => {
      const chat = await seedChat(runtime, people);
      return `${String(chat.spaces)} spaces, ${String(chat.directMessages)} direct and ${String(chat.groupMessages)} group conversations, ${String(chat.messages)} messages (${String(chat.threadReplies)} thread replies, ${String(chat.reactions)} reactions, ${String(chat.pins)} pins, ${String(chat.edited)} edited, ${String(chat.deleted)} deleted, ${String(chat.attachments)} attachments)`;
    });
    await phase("calendar", async () => {
      const calendar = await seedCalendar(runtime, people);
      return `${String(calendar.events)} events (${String(calendar.series)} recurring series), ${String(calendar.withMeet)} with Meet, ${String(calendar.pastMeetings)} past meetings, ${String(calendar.todaysMeetings)} meetings today, ${String(calendar.sharedCalendars)} calendar shares`;
    });
    await phase("contacts", async () => {
      const contacts = await seedContacts(runtime, people);
      return `${String(contacts.contacts)} contacts (${String(contacts.duplicates)} duplicates to merge) under ${String(contacts.labels)} labels`;
    });
    await phase("assistant", async () => {
      const assistant = await seedAssistant(runtime, people);
      return `${String(assistant.conversations)} conversations, ${String(assistant.messages)} messages, ${String(assistant.toolCalls)} tool calls, ${String(assistant.feedback)} ratings`;
    });
    await phase("admin", async () => {
      const admin = await seedAdmin(runtime, people);
      return `${String(admin.policies)} security policies, ${String(admin.appPasswords)} app passwords, ${String(admin.s3Keys)} S3 keys, ${String(admin.oauthApps)} OAuth apps, ${String(admin.serviceAccounts)} service accounts, ${String(admin.webhooks)} webhooks with ${String(admin.webhookDeliveries)} deliveries, ${String(admin.retentionPolicies)} retention policies, ${String(admin.legalHolds)} legal holds, ${String(admin.notifications)} notifications`;
    });
  }
  await phase("lifecycle", async () => {
    const lifecycle = await seedAccountLifecycle(runtime, people);
    return `${String(lifecycle.offboarded)} former employees offboarded to their managers, ${String(lifecycle.suspended)} suspended`;
  });
  await phase("chronology", async () => {
    const updated = await runtime.tenant(async (tx) => {
      const rows = await runtime.chronology.apply(tx, runtime.orgId);
      await alignMailTimeline(tx, runtime.orgId);
      return rows;
    });
    return `${String(updated)} rows dated across ${String(preset.historyDays)} days of history`;
  });
  let validation: DemoValidation | undefined;
  await phase("validate", async () => {
    validation = await validateDemo(runtime, roster, { full: mode === "full", search });
    const indexed =
      validation.indexed === null
        ? "search not configured"
        : `${String(Object.values(validation.indexed).reduce((sum, count) => sum + count, 0))} documents reindexed, Drive reconciliation clean`;
    return `${String(validation.objectsChecked)} stored objects readable, ${String(validation.driveContentChecked)} Drive files loaded with content, ${indexed}, ${String(validation.auditRecords)} audit records chained, ${String(validation.loginsChecked)} sign-ins checked`;
  });
  if (validation === undefined) throw new DemoSeedError("Validation did not complete.");
  await writeDemoMarker(runtime, marker("complete"));
  return {
    orgId: runtime.orgId,
    size: input.options.size,
    mode,
    seeded: true,
    seconds: (Date.now() - started) / 1000,
    phases,
    logins,
    validation,
  };
}
