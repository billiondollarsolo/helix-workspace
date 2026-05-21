create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null,
  "emailVerified" boolean not null default false,
  image text,
  actor_id uuid references actors(id),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create unique index if not exists better_auth_user_email_idx on "user" (lower(email));
create unique index if not exists better_auth_user_actor_idx on "user" (actor_id) where actor_id is not null;

create table if not exists "session" (
  id text primary key,
  "userId" text not null references "user"(id) on delete cascade,
  token text not null,
  "expiresAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create unique index if not exists better_auth_session_token_idx on "session" (token);
create index if not exists better_auth_session_user_idx on "session" ("userId");

create table if not exists account (
  id text primary key,
  "userId" text not null references "user"(id) on delete cascade,
  "accountId" text not null,
  "providerId" text not null,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists better_auth_account_user_idx on account ("userId");
create unique index if not exists better_auth_account_provider_idx on account ("providerId", "accountId");

create table if not exists verification (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists better_auth_verification_identifier_idx on verification (identifier);
