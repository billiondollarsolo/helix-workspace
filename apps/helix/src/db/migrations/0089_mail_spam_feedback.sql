-- Durable mail spam / ham feedback for user Report spam, Not spam, and
-- optional auto classifiers (spamd / beta AI). Separate from mail_thread_state.spam_at
-- so learning/ops history is not erased when a user changes their mind.

create table if not exists mail_spam_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  actor_id uuid not null references actors (id) on delete cascade,
  thread_id uuid not null references threads (id) on delete cascade,
  message_id uuid references messages (id) on delete set null,
  label text not null
    check (label in ('spam', 'ham')),
  source text not null default 'user'
    check (source in ('user', 'auto_spamd', 'auto_ai', 'auto_rules')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mail_spam_feedback_org_actor_idx
  on mail_spam_feedback (org_id, actor_id, created_at desc);

create index if not exists mail_spam_feedback_thread_idx
  on mail_spam_feedback (org_id, thread_id, created_at desc);

create index if not exists mail_spam_feedback_label_idx
  on mail_spam_feedback (org_id, label, created_at desc);

alter table mail_spam_feedback enable row level security;

drop policy if exists helix_tenant_isolation on mail_spam_feedback;
create policy helix_tenant_isolation on mail_spam_feedback
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
