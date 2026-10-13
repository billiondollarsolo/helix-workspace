-- Agent mail: who may write to an agent's or service account's mailbox from
-- outside the organization, managed from Admin → Agent mail.
--
-- An agent reads its mail and acts on it, so mail is a way to instruct it.
-- Mail from outside that does not pass the agent's policy is never delivered
-- to the mailbox; it waits in mail_quarantines for an administrator.
--
-- An agent with no row here is treated as receive_mode 'allowed_senders' with
-- an empty list: nothing from outside reaches it until an administrator says
-- who may write.

create table agent_mail_policies (
  org_id uuid not null references orgs (id) on delete cascade,
  -- An agent or service account; the store refuses people.
  actor_id uuid not null,
  --   allowed_senders  Only the listed senders, and only when the message
  --                    proves it came from them (DMARC).
  --   anyone           Any sender.
  receive_mode text not null default 'allowed_senders'
    check (receive_mode in ('allowed_senders', 'anyone')),
  -- Each entry is an address ('ana@example.com') or a domain ('@example.com').
  allowed_senders text[] not null default '{}' check (cardinality(allowed_senders) <= 200),
  updated_by_actor_id uuid,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id),
  constraint agent_mail_policies_actor_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade,
  constraint agent_mail_policies_updated_by_fk
    foreign key (org_id, updated_by_actor_id)
    references actors (org_id, id) on delete set null (updated_by_actor_id)
);

alter table agent_mail_policies enable row level security;
alter table agent_mail_policies force row level security;
create policy helix_tenant_isolation on agent_mail_policies
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on agent_mail_policies as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
