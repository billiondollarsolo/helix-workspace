import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_OAUTH_ACTOR_ID,
  DEFAULT_LOCAL_OAUTH_CLIENT_ID,
  DEFAULT_LOCAL_OAUTH_EMAIL,
  DEFAULT_LOCAL_OAUTH_ORG_ID,
} from "./seed-local-oauth.js";
import {
  DEFAULT_LOCAL_DEMO_PASSWORD,
  LOCAL_DEMO_SOURCE,
  seedLocalDemo,
} from "./seed-local-demo.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("seedLocalDemo", () => {
  it("seeds local login credentials plus persisted workspace data", async () => {
    const recording = createRecordingSql();
    const storage = createRecordingStorage();

    const result = await seedLocalDemo(recording.sql, { storage });

    expect(result).toMatchObject({
      actors: 3,
      mailThreads: 4,
      driveEntries: 3,
      docs: 2,
      calendarEvents: 2,
      chatRooms: 1,
      chatMessages: 3,
      storageObjects: 5,
      volumeMailMessages: 0,
      oauth: {
        clientId: DEFAULT_LOCAL_OAUTH_CLIENT_ID,
        actorId: DEFAULT_LOCAL_OAUTH_ACTOR_ID,
        orgId: DEFAULT_LOCAL_OAUTH_ORG_ID,
      },
      login: {
        email: DEFAULT_LOCAL_OAUTH_EMAIL,
        password: DEFAULT_LOCAL_DEMO_PASSWORD,
      },
    });
    expect(result.oauth.sampleTokenCommand).toContain("/oauth/token");
    expect(recording.beginCalls).toBe(1);

    const sqlText = recording.calls.map((call) => call.text).join("\n");
    expect(sqlText).toContain("insert into orgs");
    expect(recording.calls.some((call) => call.values.includes(DEFAULT_LOCAL_OAUTH_ORG_ID))).toBe(
      true,
    );
    expect(sqlText).toContain('insert into "user"');
    expect(sqlText).toContain("insert into account");
    expect(sqlText).toContain("credential");
    expect(sqlText).toContain("insert into messages");
    expect(sqlText).toContain("insert into drive_folders");
    expect(sqlText).toContain("insert into docs_documents");
    expect(sqlText).toContain("insert into cal_events");
    expect(sqlText).toContain("insert into chat_room_settings");
    expect(sqlText).toContain("insert into chat_read_receipts");
    expect(sqlText).toContain("insert into chat_reactions");
    expect(sqlText).toContain("insert into permissions");
    expect(recording.jsonValues).toContainEqual({ source: LOCAL_DEMO_SOURCE });
    expect(recording.arrays.some((value) => value.includes("mail.read"))).toBe(true);
    const localAdminActorInsert = recording.calls.find(
      (call) =>
        call.text.includes("insert into actors") &&
        call.values.includes(DEFAULT_LOCAL_OAUTH_ACTOR_ID),
    );
    expect(localAdminActorInsert?.values).toContainEqual(expect.arrayContaining(["docs.comment"]));
    expect(storage.ensureBucketCalls).toBe(1);
    expect(storage.puts.map((put) => put.key)).toEqual([
      "demo/00000000-0000-4000-8000-000000000100/00000000-0000-4000-8000-000000000302/AI Services and Keys",
      "demo/00000000-0000-4000-8000-000000000100/00000000-0000-4000-8000-000000000303/Training Course Links",
      "docs/00000000-0000-4000-8000-000000000100/00000000-0000-4000-8000-000000000401",
      "docs/00000000-0000-4000-8000-000000000100/00000000-0000-4000-8000-000000000403",
      "mail/00000000-0000-4000-8000-000000000602/order-summary.txt",
    ]);
  });

  it("adds opt-in deterministic volume mail without changing curated storage objects", async () => {
    const recording = createRecordingSql();
    const storage = createRecordingStorage();

    const result = await seedLocalDemo(recording.sql, {
      storage,
      volumeSearch: { mailMessages: 2 },
    });

    expect(result).toMatchObject({
      mailThreads: 4,
      volumeMailMessages: 2,
      storageObjects: 5,
    });
    const sqlText = recording.calls.map((call) => call.text).join("\n");
    const volumeJsonRows = recording.jsonValues.flatMap((value): readonly unknown[] =>
      isUnknownArray(value) ? value : [value],
    );
    expect(sqlText).toContain("insert into mail_thread_state");
    expect(sqlText.match(/jsonb_to_recordset/g)).toHaveLength(4);
    expect(volumeJsonRows.some(hasVolumeMailMetadata)).toBe(true);
    expect(
      volumeJsonRows.some(
        (row) => isRecord(row) && row.subject === "helix-volume-mail-search message 00001",
      ),
    ).toBe(true);
    expect(storage.puts).toHaveLength(5);
  });

  it("shifts visible demo activity dates with an anchor date while keeping ids stable", async () => {
    const recording = createRecordingSql();
    const storage = createRecordingStorage();

    const result = await seedLocalDemo(recording.sql, {
      anchorDate: "2026-05-28",
      storage,
      volumeSearch: { mailMessages: 1 },
    });

    expect(result.anchorDate).toBe("2026-05-28");
    expect(storage.puts.map((put) => put.key)).toContain(
      "mail/00000000-0000-4000-8000-000000000602/order-summary.txt",
    );
    const dates = recording.calls
      .flatMap((call) => call.values)
      .filter(isDate)
      .map((date) => date.toISOString());
    expect(dates).toContain("2026-05-27T14:00:00.000Z");
    expect(dates).toContain("2026-05-28T17:00:00.000Z");
    expect(dates).toContain("2026-05-27T10:20:00.000Z");
    expect(dates).toContain("2026-05-27T13:12:00.000Z");

    const volumeRows = recording.jsonValues.flatMap((value): readonly unknown[] =>
      isUnknownArray(value) ? value : [value],
    );
    expect(
      volumeRows.some(
        (row) =>
          isRecord(row) &&
          row.id === "00000000-0000-4200-8000-000000000001" &&
          row.sent_at === "2026-05-08T12:01:01.000Z",
      ),
    ).toBe(true);
  });
});

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly arrays: readonly (readonly unknown[])[];
  readonly jsonValues: readonly unknown[];
  readonly beginCalls: number;
} {
  const calls: RecordedQuery[] = [];
  const arrays: (readonly unknown[])[] = [];
  const jsonValues: unknown[] = [];
  let beginCalls = 0;

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => {
      arrays.push(value);
      return value;
    },
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) => {
      beginCalls += 1;
      return callback(sql as unknown as postgres.TransactionSql);
    },
    json: (value: unknown) => {
      jsonValues.push(value);
      return value;
    },
  }) as unknown as postgres.Sql;

  return {
    sql,
    calls,
    arrays,
    jsonValues,
    get beginCalls() {
      return beginCalls;
    },
  };
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function hasVolumeMailMetadata(row: unknown): boolean {
  if (!isRecord(row) || !isRecord(row.metadata)) {
    return false;
  }
  return (
    row.metadata.source === "local-demo-volume" &&
    row.metadata.marker === "helix-volume-mail-search"
  );
}

function createRecordingStorage(): {
  readonly ensureBucket: () => Promise<void>;
  readonly put: (object: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
  }) => Promise<void>;
  readonly get: () => Promise<null>;
  readonly delete: () => Promise<void>;
  readonly puts: readonly {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
  }[];
  readonly ensureBucketCalls: number;
} {
  const puts: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
  }[] = [];
  let ensureBucketCalls = 0;
  return {
    async ensureBucket() {
      ensureBucketCalls += 1;
    },
    async put(object) {
      puts.push(object);
    },
    async get() {
      return null;
    },
    async delete() {},
    puts,
    get ensureBucketCalls() {
      return ensureBucketCalls;
    },
  };
}
