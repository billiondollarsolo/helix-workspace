import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { ExternalEmailMfa } from "./external-email-mfa.js";

async function fixture(realSql?: postgres.Sql) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = {
    started,
    canSend: true,
    fail: false,
    delivered: [] as string[],
    wait: Promise.resolve(),
  };
  const sql = createRecordingSql(({ text }) => {
    if (text.startsWith("update auth_external_email_factors")) {
      if (!state.canSend) return [];
      state.canSend = false;
      return [{ email: "verified@example.test" }];
    }
    if (text.includes("from auth_external_email_factors"))
      return [{ email: "verified@example.test", enabled: true, verified_at: new Date() }];
    return [];
  });
  const factor = new ExternalEmailMfa(
    realSql ?? sql.sql,
    "test-email-otp-secret-at-least-thirty-two-characters",
    {
      ready: async () => true,
      send: async ({ code }) => {
        markStarted();
        await state.wait;
        if (state.fail) throw new Error("SMTP fixture unavailable");
        state.delivered.push(code);
      },
    },
  );
  const auth = betterAuth({
    database: memoryAdapter(database),
    baseURL: "http://localhost:3000",
    secret: "test-email-otp-secret-at-least-thirty-two-characters",
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    plugins: [
      factor.deliveryPlugin(),
      twoFactor({
        otpOptions: {
          digits: 6,
          period: 5,
          allowedAttempts: 5,
          storeOTP: "hashed",
          sendOTP: ({ user, otp }) => factor.sendSignInCode(user.id, otp),
        },
      }),
    ],
  });
  const identity = { email: "fixture@example.test", password: randomUUID() };
  await auth.api.signUpEmail({ body: { ...identity, name: "OTP fixture" } });
  const user = database.user?.[0];
  if (!user) throw new Error("User fixture is missing");
  if (realSql) {
    await realSql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${String(user.id)},'OTP database fixture',${identity.email},true,now(),now())`;
    await realSql`insert into auth_external_email_factors (auth_user_id,email,verified_at,enabled) values (${String(user.id)},'verified@example.test',now(),true)`;
  }
  user.twoFactorEnabled = true;
  const login = await auth.api.signInEmail({ body: identity, asResponse: true });
  expect((await login.json()).twoFactorRedirect).toBe(true);
  const headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  });
  return {
    state,
    database,
    userId: String(user.id),
    send: () =>
      factor.handleAuth(() => auth.api.sendTwoFactorOTP({ headers, body: {}, asResponse: true })),
    verify: (code: string) =>
      auth.api.verifyTwoFactorOTP({ headers, body: { code }, asResponse: true }),
    rows: () =>
      database.verification?.filter((row) => String(row.identifier).startsWith("2fa-otp-")) ?? [],
  };
}

describe("maintained email OTP delivery", () => {
  it("keeps the delivered code valid after a rejected resend, and consumes it once", async () => {
    const f = await fixture();
    expect((await f.send()).status).toBe(200);
    const prior = JSON.stringify(f.rows());
    await expect(f.send()).rejects.toMatchObject({ statusCode: 429 });
    expect(JSON.stringify(f.rows())).toBe(prior);
    expect(f.state.delivered).toHaveLength(1);
    expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).toBe(200);
    expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).not.toBe(200);
  });

  it("publishes the later delivered code after the cooldown", async () => {
    const f = await fixture();
    await f.send();
    f.state.canSend = true;
    await f.send();
    expect(f.state.delivered).toHaveLength(2);
    if (f.state.delivered[0] !== f.state.delivered[1])
      expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).toBe(401);
    expect((await f.verify(f.state.delivered[1] ?? "missing-code")).status).toBe(200);
  });

  it("does not replace a delivered challenge when SMTP fails", async () => {
    const f = await fixture();
    await f.send();
    const prior = JSON.stringify(f.rows());
    f.state.canSend = true;
    f.state.fail = true;
    await expect(f.send()).rejects.toThrow("could not be sent");
    expect(JSON.stringify(f.rows())).toBe(prior);
    expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).toBe(200);
  });

  it("starts the code lifetime when delivery finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const startedAt = Date.now();
      const f = await fixture();
      let release!: () => void;
      f.state.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sending = f.send();
      await f.state.started;
      vi.setSystemTime(startedAt + 4 * 60_000);
      release();
      expect((await sending).status).toBe(200);
      vi.setSystemTime(startedAt + 6 * 60_000);
      expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a code unpublished while delivery waits and rejects a competing resend", async () => {
    const f = await fixture();
    let release!: () => void;
    f.state.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.send();
    await f.state.started;
    expect(f.state.canSend).toBe(false);
    expect(f.rows()).toHaveLength(0);
    await expect(f.send()).rejects.toMatchObject({ statusCode: 429 });
    release();
    expect((await first).status).toBe(200);
    expect(f.rows()).toHaveLength(1);
    expect(f.state.delivered).toHaveLength(1);
  });
});

describe(
  "PostgreSQL email OTP reservation",
  { skip: process.env.HELIX_MIGRATION_DATABASE_URL === undefined },
  () => {
    it("serializes competing sends across connections and rolls the cooldown back on failure", async () => {
      const sql = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", {
        max: 3,
        prepare: false,
      });
      let userId: string | undefined;
      try {
        const f = await fixture(sql);
        userId = f.userId;
        let release!: () => void;
        f.state.wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = f.send();
        await f.state.started;
        const second = f.send();
        release();
        expect((await first).status).toBe(200);
        await expect(second).rejects.toMatchObject({ statusCode: 429 });
        expect(f.state.delivered).toHaveLength(1);
        const before = JSON.stringify(f.rows());
        await sql`update auth_external_email_factors set last_sent_at=null where auth_user_id=${userId}`;
        f.state.fail = true;
        await expect(f.send()).rejects.toThrow("could not be sent");
        expect(JSON.stringify(f.rows())).toBe(before);
        expect(
          (
            await sql`select last_sent_at from auth_external_email_factors where auth_user_id=${userId}`
          )[0]?.last_sent_at,
        ).toBeNull();
        expect((await f.verify(f.state.delivered[0] ?? "missing-code")).status).toBe(200);
      } finally {
        if (userId) await sql`delete from "user" where id=${userId}`;
        await sql.end();
      }
    });
  },
);
