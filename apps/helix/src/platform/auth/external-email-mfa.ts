import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import type postgres from "postgres";
import type { AccountEmailFactorStatus } from "@helix/contracts";
import { ApiError, BadRequestError } from "../../api/api-error.js";
import { detachedFromTenantPostgresContext } from "../tenancy/postgres-roles.js";

interface FactorRow {
  readonly email: string | null;
  readonly verified_at: Date | null;
  readonly enabled: boolean;
  readonly pending_email: string | null;
  readonly pending_code_digest: string | null;
  readonly pending_expires_at: Date | null;
  readonly pending_attempts: number;
}

export interface IdentityCodeSender {
  ready(): Promise<boolean>;
  send(input: {
    readonly email: string;
    readonly code: string;
    readonly purpose: "verification" | "sign-in";
  }): Promise<void>;
}

/** The maintained 2FA plugin owns sign-in challenges; this owns verified recipients. */
export class ExternalEmailMfa {
  private readonly delivery = new AsyncLocalStorage<{
    error: ApiError | null;
    publish?: () => Promise<void>;
  }>();

  constructor(
    private readonly sql: postgres.Sql,
    private readonly secret: string,
    private readonly sender?: IdentityCodeSender,
  ) {}

  digest(code: string): string {
    return createHmac("sha256", this.secret).update(`helix-email-code:${code}`).digest("hex");
  }

  async status(userId: string, checkMail = true): Promise<AccountEmailFactorStatus> {
    const [factor] = await this.sql<
      FactorRow[]
    >`select * from auth_external_email_factors where auth_user_id = ${userId}`;
    const totp = await this
      .sql`select 1 from "twoFactor" where "userId" = ${userId} and verified = true`;
    return {
      outboundReady: checkMail ? await this.ready() : this.sender !== undefined,
      email: factor?.email ?? null,
      verified: factor?.verified_at != null,
      enabled: factor?.enabled === true,
      totpEnabled: totp.length > 0,
      pendingEmail: factor?.pending_email ?? null,
    };
  }

  async ready(): Promise<boolean> {
    return this.sender !== undefined && (await this.sender.ready().catch(() => false));
  }

  async beginVerification(userId: string, email: string, accountEmail: string): Promise<void> {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const workspaceDomain = accountEmail.slice(accountEmail.lastIndexOf("@") + 1).toLowerCase();
    const [hosted] = await this.sql<
      { hosted: boolean }[]
    >`select helix_is_hosted_mail_domain(${domain}) as hosted`;
    if (domain === workspaceDomain || hosted?.hosted)
      throw new BadRequestError("Use an external inbox outside Helix's mail domains.");
    const sender = this.sender;
    if (sender === undefined || !(await this.ready()))
      throw new ApiError(
        "internal_error",
        "Outbound email is not working. Configure and test it before setting up email codes.",
      );
    const code = randomInt(1_000_000).toString().padStart(6, "0");
    const rows = await detachedFromTenantPostgresContext(
      () => this.sql`
      insert into auth_external_email_factors (auth_user_id, pending_email, pending_code_digest, pending_expires_at, last_sent_at)
      values (${userId}, ${email}, ${this.digest(`${userId}:${email}:${code}`)}, now() + interval '10 minutes', now())
      on conflict (auth_user_id) do update set pending_email = excluded.pending_email,
        pending_code_digest = excluded.pending_code_digest, pending_expires_at = excluded.pending_expires_at,
        pending_attempts = 0, last_sent_at = now(), updated_at = now()
      where auth_external_email_factors.last_sent_at is null or auth_external_email_factors.last_sent_at < now() - interval '60 seconds'
      returning auth_user_id
    `,
    );
    if (rows.length === 0) throw this.rateLimit();
    try {
      await sender.send({ email, code, purpose: "verification" });
    } catch {
      await detachedFromTenantPostgresContext(
        () =>
          this
            .sql`update auth_external_email_factors set pending_code_digest = null, pending_expires_at = null where auth_user_id = ${userId}`,
      );
      throw new ApiError(
        "internal_error",
        "The verification email could not be sent. Check outbound email and try again.",
      );
    }
  }

  async verifyAddress(userId: string, code: string): Promise<void> {
    const verified = await detachedFromTenantPostgresContext(() =>
      this.sql.begin(async (tx) => {
        const [factor] = await tx<
          FactorRow[]
        >`select * from auth_external_email_factors where auth_user_id = ${userId} for update`;
        if (
          !factor?.pending_email ||
          !factor.pending_code_digest ||
          !factor.pending_expires_at ||
          factor.pending_expires_at <= new Date() ||
          factor.pending_attempts >= 5
        )
          return false;
        const expected = Buffer.from(factor.pending_code_digest, "hex");
        const supplied = Buffer.from(
          this.digest(`${userId}:${factor.pending_email}:${code}`),
          "hex",
        );
        if (!timingSafeEqual(expected, supplied)) {
          await tx`update auth_external_email_factors set pending_attempts = pending_attempts + 1 where auth_user_id = ${userId}`;
          return false;
        }
        await this.clearChallenges(tx, userId);
        await tx`update "session" set mfa_verified_at = null, mfa_audience = null where "userId" = ${userId}`;
        await tx`update auth_external_email_factors set email = pending_email, verified_at = now(),
        pending_email = null, pending_code_digest = null, pending_expires_at = null, pending_attempts = 0,
        last_sent_at = null, updated_at = now() where auth_user_id = ${userId}`;
        return true;
      }),
    );
    if (!verified)
      throw new BadRequestError(
        "That code is incorrect, expired or already used. Request a new verification code.",
      );
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    if (enabled && !(await this.ready()))
      throw new ApiError(
        "internal_error",
        "Outbound email must be working before enabling email codes.",
      );
    await detachedFromTenantPostgresContext(() =>
      this.sql.begin(async (tx) => {
        const changed =
          await tx`update auth_external_email_factors set enabled = ${enabled}, updated_at = now()
        where auth_user_id = ${userId} and verified_at is not null returning auth_user_id`;
        if (changed.length === 0)
          throw new BadRequestError(
            "Verify an external email address before enabling email codes.",
          );
        await this.clearChallenges(tx, userId);
        await tx`update "session" set mfa_verified_at = null, mfa_audience = null where "userId" = ${userId}`;
        await tx`update "user" set "twoFactorEnabled" = ${enabled} or exists (
        select 1 from "twoFactor" where "userId" = ${userId} and verified = true
      ), "updatedAt" = now() where id = ${userId}`;
      }),
    );
  }

  async retainEmailFactor(userId: string): Promise<void> {
    await this.sql`update "user" set "twoFactorEnabled" = true where id = ${userId}
      and exists (select 1 from auth_external_email_factors where auth_user_id = ${userId} and enabled and verified_at is not null)`;
    await this
      .sql`update "session" set mfa_verified_at = null, mfa_audience = null where "userId" = ${userId}`;
  }

  async availableForEmail(email: string): Promise<boolean> {
    const rows = await this
      .sql`select 1 from auth_external_email_factors factor join "user" u on u.id = factor.auth_user_id
      where lower(u.email) = ${email.toLowerCase()} and factor.enabled and factor.verified_at is not null`;
    return this.sender !== undefined && rows.length > 0;
  }

  async sendSignInCode(userId: string, code: string): Promise<void> {
    try {
      const context = this.delivery.getStore();
      const publish = context?.publish;
      if (context === undefined || publish === undefined)
        throw new ApiError(
          "internal_error",
          "The email sign-in challenge could not be prepared. Try again.",
        );
      const sender = this.sender;
      if (sender === undefined || !(await this.ready()))
        throw new ApiError(
          "internal_error",
          "Outbound email is unavailable. Try another verification method or restore mail delivery.",
        );
      await detachedFromTenantPostgresContext(() =>
        this.sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`helix-email-otp:${userId}`}, 0))`;
          const rows = await tx<
            { email: string }[]
          >`update auth_external_email_factors set last_sent_at = clock_timestamp()
        where auth_user_id = ${userId} and enabled and verified_at is not null
          and (last_sent_at is null or last_sent_at < clock_timestamp() - interval '60 seconds') returning email`;
          const recipient = rows[0];
          if (recipient === undefined) {
            const [factor] = await tx<
              Pick<FactorRow, "enabled" | "verified_at">[]
            >`select enabled,verified_at from auth_external_email_factors where auth_user_id=${userId}`;
            if (factor?.enabled !== true || factor.verified_at === null)
              throw new BadRequestError(
                "Enable email codes with a verified external address first.",
              );
            throw this.rateLimit();
          }
          await sender.send({ email: recipient.email, code, purpose: "sign-in" });
          await tx`update auth_external_email_factors set last_sent_at=clock_timestamp() where auth_user_id=${userId}`;
          // Publish only after delivery; a rejected send leaves the earlier plugin challenge intact.
          await publish();
          delete context.publish;
        }),
      );
    } catch (error) {
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(
              "internal_error",
              "Your sign-in code could not be sent. Try another method or check outbound email.",
            );
      const context = this.delivery.getStore();
      if (context) context.error = failure;
      throw failure;
    }
  }

  deliveryPlugin(): BetterAuthPlugin {
    return {
      id: "helix-email-otp-delivery",
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === "/two-factor/send-otp",
            handler: createAuthMiddleware(async (ctx) => {
              const adapter = ctx.context.internalAdapter;
              return {
                context: {
                  context: {
                    internalAdapter: {
                      ...adapter,
                      createVerificationValue: async (
                        data: Parameters<typeof adapter.createVerificationValue>[0],
                      ) => {
                        if (!data.identifier.startsWith("2fa-otp-"))
                          return adapter.createVerificationValue(data);
                        const delivery = this.delivery.getStore();
                        if (delivery === undefined)
                          throw new ApiError(
                            "internal_error",
                            "Email code delivery requires a protected authentication request.",
                          );
                        const pending = {
                          id: randomUUID(),
                          createdAt: new Date(),
                          updatedAt: new Date(),
                          ...data,
                        };
                        const lifetimeMs = Math.max(0, data.expiresAt.getTime() - Date.now());
                        delivery.publish = async () => {
                          const publishedAt = new Date();
                          await adapter.createVerificationValue({
                            ...pending,
                            createdAt: publishedAt,
                            updatedAt: publishedAt,
                            expiresAt: new Date(publishedAt.getTime() + lifetimeMs),
                          });
                        };
                        return pending;
                      },
                    },
                  },
                },
              };
            }),
          },
        ],
      },
    };
  }

  async handleAuth(operation: () => Promise<Response>): Promise<Response> {
    return this.delivery.run({ error: null }, async () => {
      const response = await operation();
      const error = this.delivery.getStore()?.error;
      if (error) throw error;
      return response;
    });
  }

  private rateLimit(): ApiError {
    return new ApiError("rate_limited", "Wait 60 seconds before requesting another email code.", {
      retryAfterSeconds: 60,
    });
  }

  private async clearChallenges(tx: postgres.TransactionSql, userId: string): Promise<void> {
    await tx`delete from verification where starts_with(identifier, ${`2fa-otp-${userId}!`})
      or identifier in (select '2fa-otp-' || identifier from verification where value = ${userId} and identifier like '2fa-%')`;
    await tx`delete from verification where value = ${userId} and identifier like '2fa-%'`;
  }
}
