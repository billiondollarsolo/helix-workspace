-- One governed lifecycle for non-human OAuth clients, API keys, and mTLS
-- certificates. Credential material remains hashed; every mutation is
-- tenant-bound and commits its audit/outbox evidence atomically.

alter table agent_credentials rename column created_by to owner_actor_id;
alter table agent_credentials rename constraint agent_credentials_created_by_fkey
  to agent_credentials_owner_actor_id_fkey;

alter table agent_credentials
  add column org_id uuid,
  add column purpose text,
  add column rotated_at timestamptz,
  add column updated_at timestamptz not null default now();

update agent_credentials credential
set org_id = actor.org_id,
    owner_actor_id = coalesce(credential.owner_actor_id, credential.actor_id),
    purpose = coalesce(nullif(credential.metadata->>'purpose', ''), nullif(credential.label, ''),
                       'Non-human integration'),
    label = coalesce(nullif(credential.label, ''), 'Non-human credential'),
    expires_at = coalesce(credential.expires_at, credential.created_at + interval '90 days')
from actors actor
where actor.id = credential.actor_id;

alter table agent_credentials
  alter column org_id set not null,
  alter column owner_actor_id set not null,
  alter column purpose set not null,
  alter column label set not null,
  alter column expires_at set not null,
  add constraint agent_credentials_org_id_fk foreign key (org_id) references orgs(id) on delete cascade,
  add constraint agent_credentials_actor_org_fk foreign key (org_id, actor_id)
    references actors(org_id, id) on delete cascade,
  add constraint agent_credentials_owner_org_fk foreign key (org_id, owner_actor_id)
    references actors(org_id, id) on delete restrict,
  add constraint agent_credentials_purpose_check check (length(btrim(purpose)) between 1 and 500),
  add constraint agent_credentials_label_check check (length(btrim(label)) between 1 and 200),
  add constraint agent_credentials_scopes_check check (cardinality(scopes) > 0),
  add constraint agent_credentials_expiry_check check (expires_at > created_at);

create index agent_credentials_inventory_idx
  on agent_credentials (org_id, revoked_at, expires_at, credential_type);

create function helix_issue_nonhuman_credential(
  input_org_id uuid,
  input_operator_actor_id uuid,
  input_principal_actor_id uuid,
  input_credential_type text,
  input_label text,
  input_purpose text,
  input_scopes text[],
  input_expires_at timestamptz,
  input_client_id text default null,
  input_secret_hash text default null,
  input_api_key_hash text default null,
  input_cert_fingerprint text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  credential_id uuid;
  principal_type actor_type;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_actor_id
  then
    raise insufficient_privilege using message = 'credential operator context mismatch';
  end if;
  if not exists (
    select 1 from actors where org_id = input_org_id and id = input_operator_actor_id
      and type = 'user' and disabled_at is null
  ) then
    raise insufficient_privilege using message = 'credential owner must be an active user';
  end if;
  select type into principal_type from actors
  where org_id = input_org_id and id = input_principal_actor_id and disabled_at is null;
  if principal_type is null or principal_type not in ('agent', 'service_account') then
    raise check_violation using message = 'credential principal must be an active agent or service account';
  end if;
  if input_expires_at is null or input_expires_at <= statement_timestamp()
    or input_expires_at > statement_timestamp() + interval '366 days'
  then
    raise check_violation using message = 'credential expiry must be within 366 days';
  end if;
  if cardinality(input_scopes) is null or cardinality(input_scopes) = 0 then
    raise check_violation using message = 'credential requires at least one scope';
  end if;
  if (input_credential_type = 'oauth_client' and
      (nullif(input_client_id, '') is null or coalesce(input_secret_hash !~ '^[$]argon2id[$]', true)
       or input_api_key_hash is not null or input_cert_fingerprint is not null))
    or (input_credential_type = 'api_key' and
      (coalesce(input_api_key_hash !~ '^[0-9a-f]{64}$', true) or input_client_id is not null
       or input_secret_hash is not null or input_cert_fingerprint is not null))
    or (input_credential_type = 'mtls_cert' and
      (coalesce(input_cert_fingerprint !~ '^[0-9a-f]{64}$', true) or input_client_id is not null
       or input_secret_hash is not null or input_api_key_hash is not null))
  then
    raise check_violation using message = 'invalid credential material';
  end if;

  insert into agent_credentials (
    org_id, actor_id, owner_actor_id, credential_type, label, purpose, scopes,
    expires_at, client_id, secret_hash, api_key_hash, cert_fingerprint
  ) values (
    input_org_id, input_principal_actor_id, input_operator_actor_id,
    input_credential_type, btrim(input_label), btrim(input_purpose), input_scopes,
    input_expires_at, input_client_id, input_secret_hash, input_api_key_hash,
    input_cert_fingerprint
  ) returning id into credential_id;

  insert into activity (
    org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash
  ) values (
    input_org_id, input_operator_actor_id, 'nonhuman.credential.issued',
    'agent_credential', credential_id,
    jsonb_build_object('credentialType', input_credential_type, 'principalType', principal_type,
      'principalActorId', input_principal_actor_id, 'ownerActorId', input_operator_actor_id,
      'purpose', btrim(input_purpose), 'scopes', input_scopes, 'expiresAt', input_expires_at),
    null, ''
  );
  insert into outbox (subject, payload) values (
    'security.nonhuman-credential.changed',
    jsonb_build_object('event', 'issued', 'orgId', input_org_id,
      'credentialId', credential_id, 'credentialType', input_credential_type,
      'principalActorId', input_principal_actor_id)
  );
  return credential_id;
end
$$;

create function helix_rotate_nonhuman_credential(
  input_org_id uuid,
  input_operator_actor_id uuid,
  input_credential_id uuid,
  input_expires_at timestamptz,
  input_secret_hash text default null,
  input_api_key_hash text default null,
  input_cert_fingerprint text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  credential agent_credentials;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_actor_id
  then
    raise insufficient_privilege using message = 'credential operator context mismatch';
  end if;
  select * into credential from agent_credentials
  where org_id = input_org_id and id = input_credential_id and revoked_at is null
  for update;
  if not found then return false; end if;
  if credential.owner_actor_id <> input_operator_actor_id then
    raise insufficient_privilege using message = 'only the accountable owner may rotate a credential';
  end if;
  if input_expires_at <= statement_timestamp()
    or input_expires_at > statement_timestamp() + interval '366 days'
  then
    raise check_violation using message = 'credential expiry must be within 366 days';
  end if;
  if (credential.credential_type = 'oauth_client' and input_secret_hash is null)
    or (credential.credential_type = 'api_key' and input_api_key_hash is null)
    or (credential.credential_type = 'mtls_cert' and input_cert_fingerprint is null)
  then
    raise check_violation using message = 'rotation material does not match credential type';
  end if;
  if (credential.credential_type = 'oauth_client' and coalesce(input_secret_hash !~ '^[$]argon2id[$]', true))
    or (credential.credential_type = 'api_key' and coalesce(input_api_key_hash !~ '^[0-9a-f]{64}$', true))
    or (credential.credential_type = 'mtls_cert' and coalesce(input_cert_fingerprint !~ '^[0-9a-f]{64}$', true))
  then
    raise check_violation using message = 'invalid rotation material';
  end if;

  update agent_credentials set
    secret_hash = case when credential_type = 'oauth_client' then input_secret_hash else null end,
    api_key_hash = case when credential_type = 'api_key' then input_api_key_hash else null end,
    cert_fingerprint = case when credential_type = 'mtls_cert' then input_cert_fingerprint else null end,
    expires_at = input_expires_at,
    rotated_at = statement_timestamp(),
    updated_at = statement_timestamp(),
    revocation_epoch = revocation_epoch + 1
  where id = input_credential_id;

  insert into activity (
    org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash
  ) values (
    input_org_id, input_operator_actor_id, 'nonhuman.credential.rotated',
    'agent_credential', input_credential_id,
    jsonb_build_object('credentialType', credential.credential_type,
      'principalActorId', credential.actor_id, 'expiresAt', input_expires_at), null, ''
  );
  insert into outbox (subject, payload) values (
    'security.nonhuman-credential.changed',
    jsonb_build_object('event', 'rotated', 'orgId', input_org_id,
      'credentialId', input_credential_id, 'credentialType', credential.credential_type,
      'principalActorId', credential.actor_id)
  );
  return true;
end
$$;

create function helix_revoke_nonhuman_credential(
  input_org_id uuid,
  input_operator_actor_id uuid,
  input_credential_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  credential agent_credentials;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_actor_id
  then
    raise insufficient_privilege using message = 'credential operator context mismatch';
  end if;
  select * into credential from agent_credentials
  where org_id = input_org_id and id = input_credential_id and revoked_at is null
  for update;
  if not found then return false; end if;
  if not exists (
    select 1 from actors where org_id = input_org_id and id = input_operator_actor_id
      and type = 'user' and disabled_at is null
  ) then
    raise insufficient_privilege using message = 'credential revocation requires an active administrator';
  end if;
  update agent_credentials set revoked_at = statement_timestamp(), updated_at = statement_timestamp(),
    revocation_epoch = revocation_epoch + 1
  where id = input_credential_id;

  insert into activity (
    org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash
  ) values (
    input_org_id, input_operator_actor_id, 'nonhuman.credential.revoked',
    'agent_credential', input_credential_id,
    jsonb_build_object('credentialType', credential.credential_type,
      'principalActorId', credential.actor_id), null, ''
  );
  insert into outbox (subject, payload) values (
    'security.nonhuman-credential.changed',
    jsonb_build_object('event', 'revoked', 'orgId', input_org_id,
      'credentialId', input_credential_id, 'credentialType', credential.credential_type,
      'principalActorId', credential.actor_id)
  );
  return true;
end
$$;

alter function helix_issue_nonhuman_credential(
  uuid, uuid, uuid, text, text, text, text[], timestamptz, text, text, text, text
) owner to helix_migration_owner;
alter function helix_rotate_nonhuman_credential(
  uuid, uuid, uuid, timestamptz, text, text, text
) owner to helix_migration_owner;
alter function helix_revoke_nonhuman_credential(uuid, uuid, uuid) owner to helix_migration_owner;

revoke execute on function helix_issue_nonhuman_credential(
  uuid, uuid, uuid, text, text, text, text[], timestamptz, text, text, text, text
) from public;
revoke execute on function helix_rotate_nonhuman_credential(
  uuid, uuid, uuid, timestamptz, text, text, text
) from public;
revoke execute on function helix_revoke_nonhuman_credential(uuid, uuid, uuid) from public;
grant execute on function helix_issue_nonhuman_credential(
  uuid, uuid, uuid, text, text, text, text[], timestamptz, text, text, text, text
) to helix_app;
grant execute on function helix_rotate_nonhuman_credential(
  uuid, uuid, uuid, timestamptz, text, text, text
) to helix_app;
grant execute on function helix_revoke_nonhuman_credential(uuid, uuid, uuid) to helix_app;
