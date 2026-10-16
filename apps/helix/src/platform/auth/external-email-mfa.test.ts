import { describe, expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { ExternalEmailMfa, type IdentityCodeSender } from "./external-email-mfa.js";

const secret = "external-email-code-test-secret-at-least-32-characters";
const sender = () => ({
  ready: vi.fn(async () => true),
  send: vi.fn<IdentityCodeSender["send"]>(async () => undefined),
});

describe("verified external email MFA", () => {
  it("requires working outbound delivery and rejects hosted inboxes before sending", async () => {
    const mail = sender();
    const hosted = new ExternalEmailMfa(createRecordingSql([[{ hosted: true }]]).sql, secret, mail);
    await expect(
      hosted.beginVerification("user", "someone@helix.test", "me@other.test"),
    ).rejects.toThrow("external inbox");
    const missing = new ExternalEmailMfa(createRecordingSql([[{ hosted: false }]]).sql, secret);
    await expect(
      missing.beginVerification("user", "me@gmail.com", "me@helix.test"),
    ).rejects.toThrow("not working");
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("sends six digits and persists only a keyed digest bound to the address and user", async () => {
    const sql = createRecordingSql([[{ hosted: false }], [{ auth_user_id: "user" }]]);
    const mail = sender();
    const factor = new ExternalEmailMfa(sql.sql, secret, mail);
    await factor.beginVerification("user", "me@gmail.com", "me@helix.test");
    const code = mail.send.mock.calls[0]?.[0]?.code;
    if (code === undefined) throw new Error("Verification code was not sent");
    expect(code).toMatch(/^\d{6}$/u);
    expect(sql.calls[1]?.values).toContain(factor.digest(`user:me@gmail.com:${code}`));
    expect(sql.calls[1]?.values).not.toContain(code);
  });

  it.each(["expired", "used", "exhausted"])(
    "rejects a %s address verification challenge",
    async (reason) => {
      const factor = new ExternalEmailMfa(
        createRecordingSql([
          [
            {
              pending_email: "me@gmail.com",
              pending_code_digest: "a".repeat(64),
              pending_expires_at: new Date(Date.now() + (reason === "expired" ? -1 : 60_000)),
              pending_attempts: reason === "exhausted" ? 5 : 0,
              ...(reason === "used" ? { pending_code_digest: null } : {}),
            },
          ],
        ]).sql,
        secret,
        sender(),
      );
      await expect(factor.verifyAddress("user", "123456")).rejects.toThrow(
        "incorrect, expired or already used",
      );
    },
  );

  it("commits failed-attempt counting before reporting a wrong code", async () => {
    const sql = createRecordingSql([
      [
        {
          pending_email: "me@gmail.com",
          pending_code_digest: "a".repeat(64),
          pending_expires_at: new Date(Date.now() + 60_000),
          pending_attempts: 0,
        },
      ],
      [],
    ]);
    const factor = new ExternalEmailMfa(sql.sql, secret, sender());
    await expect(factor.verifyAddress("user", "123456")).rejects.toThrow("incorrect");
    expect(sql.queries[1]).toContain("pending_attempts = pending_attempts + 1");
    expect(sql.beginCalls).toBe(1);
  });

  it("consumes a correct address code and invalidates existing sign-in challenges", async () => {
    const sql = createRecordingSql();
    const factor = new ExternalEmailMfa(sql.sql, secret, sender());
    const data = createRecordingSql([
      [
        {
          pending_email: "me@gmail.com",
          pending_code_digest: factor.digest("user:me@gmail.com:123456"),
          pending_expires_at: new Date(Date.now() + 60_000),
          pending_attempts: 0,
        },
      ],
      [],
      [],
      [],
      [],
    ]);
    await new ExternalEmailMfa(data.sql, secret, sender()).verifyAddress("user", "123456");
    expect(data.queries.some((q) => q.includes("starts_with(identifier"))).toBe(true);
    expect(data.queries.some((q) => q.includes("email = pending_email"))).toBe(true);
    expect(data.queries.some((q) => q.includes("mfa_verified_at = null"))).toBe(true);
  });

  it("does not enable codes before address verification", async () => {
    const factor = new ExternalEmailMfa(createRecordingSql([[]]).sql, secret, sender());
    await expect(factor.setEnabled("user", true)).rejects.toThrow("Verify an external email");
  });

  it("keeps verified authenticator MFA when email codes are disabled", async () => {
    const sql = createRecordingSql([[{ auth_user_id: "user" }], [], [], [], []]);
    await new ExternalEmailMfa(sql.sql, secret, sender()).setEnabled("user", false);
    expect(sql.queries.at(-1)).toContain('select 1 from "twoFactor"');
    expect(sql.calls.at(-1)?.values).toContain(false);
  });

  it("refuses to send a sign-in code outside the staged authentication operation", async () => {
    const mail = sender();
    mail.send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    const factor = new ExternalEmailMfa(
      createRecordingSql([[{ email: "me@gmail.com" }]]).sql,
      secret,
      mail,
    );
    await expect(
      factor.handleAuth(async () => {
        await factor.sendSignInCode("user", "123456").catch(() => undefined);
        return Response.json({ status: true });
      }),
    ).rejects.toThrow("could not be prepared");
    expect(mail.send).not.toHaveBeenCalled();
  });
});
