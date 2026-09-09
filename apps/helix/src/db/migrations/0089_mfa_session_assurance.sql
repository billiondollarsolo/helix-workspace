-- Better Auth's maintained TOTP/recovery-code model plus an explicit,
-- short-lived assurance marker bound to the session and Helix issuer.
alter table "user"
  add column if not exists "twoFactorEnabled" boolean not null default false;

create table if not exists "twoFactor" (
  id text primary key,
  "userId" text not null references "user"(id) on delete cascade,
  secret text not null,
  "backupCodes" text not null,
  verified boolean not null default false,
  "failedVerificationCount" integer not null default 0,
  "lockedUntil" timestamptz,
  constraint better_auth_two_factor_secret_encrypted check (
    secret ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  ),
  constraint better_auth_two_factor_backup_codes_encrypted check (
    "backupCodes" ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  )
);

create unique index if not exists better_auth_two_factor_user_idx
  on "twoFactor" ("userId");
create index if not exists better_auth_two_factor_secret_idx
  on "twoFactor" (secret);

alter table "session"
  add column if not exists mfa_verified_at timestamptz,
  add column if not exists mfa_audience text;

alter table "session"
  drop constraint if exists better_auth_session_mfa_assurance_complete;
alter table "session"
  add constraint better_auth_session_mfa_assurance_complete check (
    (mfa_verified_at is null and mfa_audience is null)
    or (mfa_verified_at is not null and char_length(mfa_audience) > 0)
  );
