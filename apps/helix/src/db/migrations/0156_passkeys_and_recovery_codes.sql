-- Maintained Better Auth WebAuthn credentials. A unique credential ID and the
-- monotonic authenticator counter are the durable replay/cloning boundary.
alter table account add column if not exists issuer text;
update account
set issuer = case
  when "providerId" = 'credential' then 'local:credential'
  else 'local:oauth:' || "providerId"
end
where issuer is null;
alter table account alter column issuer set not null;
create unique index if not exists better_auth_account_issuer_idx on account (issuer, "accountId");

create table if not exists passkey (
  id text primary key,
  name text,
  "publicKey" text not null,
  "userId" text not null references "user"(id) on delete cascade,
  "credentialID" text not null,
  counter integer not null,
  "deviceType" text not null,
  "backedUp" boolean not null,
  transports text,
  "createdAt" timestamptz not null default now(),
  aaguid text,
  constraint better_auth_passkey_counter_nonnegative check (counter >= 0),
  constraint better_auth_passkey_device_type check ("deviceType" in ('singleDevice', 'multiDevice')),
  constraint better_auth_passkey_credential_not_empty check (char_length("credentialID") > 0),
  constraint better_auth_passkey_public_key_not_empty check (char_length("publicKey") > 0)
);

create unique index if not exists better_auth_passkey_credential_idx
  on passkey ("credentialID");
create index if not exists better_auth_passkey_user_idx
  on passkey ("userId");

create or replace function helix_enforce_passkey_counter_progress()
returns trigger
language plpgsql
as $$
begin
  if new.counter < old.counter
     or (new."deviceType" = 'singleDevice' and new.counter <= old.counter) then
    raise exception 'passkey authenticator counter did not advance' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists passkey_counter_progress on passkey;
create trigger passkey_counter_progress
before update of counter on passkey
for each row execute function helix_enforce_passkey_counter_progress();

-- User-visible recovery codes are never stored. Each digest maps once to an
-- independently random, Better Auth-managed backup code encrypted with the
-- versioned Better Auth secret envelope.
create table if not exists auth_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null references "user"(id) on delete cascade,
  code_digest text not null unique,
  bridge_ciphertext text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  constraint auth_recovery_code_digest_sha256 check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint auth_recovery_code_bridge_encrypted check (
    bridge_ciphertext ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  )
);

create index if not exists auth_recovery_codes_user_active_idx
  on auth_recovery_codes (auth_user_id)
  where consumed_at is null;
