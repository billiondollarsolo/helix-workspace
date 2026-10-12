-- Decision-model spam and triage (Cloudflare Workers AI Clef, TypeSafe Jev).
--
-- After an inbound message is stored, a background worker may send a compact
-- summary of it to the organization's chosen hosted decision model and record
-- the verdict here. Settings live in the tenant feature flags
-- (`mail_decision_model`, versioned by the tenant-config audit trigger); the
-- provider API key or token lives encrypted in its own table so it never
-- reaches tenant-config history.
--
--   * mail_decision_model_credentials  one sealed credential per organization
--   * mail_decision_verdicts           one row per decided, skipped, or failed message
--   * mail_spam_feedback.source        gains 'auto_decision_model'

create table mail_decision_model_credentials (
  org_id uuid primary key references orgs (id) on delete cascade,
  provider text not null check (provider in ('cloudflare', 'typesafe')),
  -- TenantEnvelopeCipher output for purpose 'mail-decision-model'.
  secret_ciphertext text not null check (
    secret_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  ),
  updated_by_actor_id uuid,
  updated_at timestamptz not null default statement_timestamp(),
  constraint mail_decision_model_credentials_updated_by_fk
    foreign key (org_id, updated_by_actor_id)
    references actors (org_id, id) on delete set null (updated_by_actor_id)
);

alter table mail_decision_model_credentials enable row level security;
alter table mail_decision_model_credentials force row level security;
create policy helix_tenant_isolation on mail_decision_model_credentials
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on mail_decision_model_credentials as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());

create table mail_decision_verdicts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  message_id uuid not null,
  thread_id uuid not null,
  provider text not null check (provider in ('cloudflare', 'typesafe')),
  model text not null check (char_length(model) between 1 and 200),
  mode text not null check (mode in ('shadow', 'enforce')),
  config_version text not null check (char_length(config_version) between 1 and 64),
  outcome text not null check (outcome in ('decided', 'skipped', 'error')),
  -- Skip or error reason (`daily_cap`, `classified_restricted`, `rate_limited`, …).
  reason text check (reason is null or char_length(reason) between 1 and 200),
  verdict text check (verdict in ('legitimate', 'spam', 'phishing', 'scam')),
  verdict_confidence double precision check (verdict_confidence between 0 and 1),
  verdict_probabilities jsonb not null default '{}'::jsonb,
  category mail_category_tab,
  category_confidence double precision check (category_confidence between 0 and 1),
  category_probabilities jsonb not null default '{}'::jsonb,
  needs_reply_probability double precision check (needs_reply_probability between 0 and 1),
  urgency text check (urgency in ('can wait', 'this week', 'today')),
  urgency_confidence double precision check (urgency_confidence between 0 and 1),
  urgency_probabilities jsonb not null default '{}'::jsonb,
  spamassassin_score double precision,
  spamassassin_is_spam boolean,
  -- Domain only: the report lists disagreements without addresses or content.
  sender_domain text check (sender_domain is null or char_length(sender_domain) <= 253),
  -- What enforce mode would do (also recorded in shadow mode) and what was done.
  proposed_action text not null default 'none'
    check (proposed_action in ('none', 'spam', 'phishing', 'category')),
  action_taken text not null default 'none'
    check (action_taken in ('none', 'spam', 'phishing', 'category')),
  latency_ms integer check (latency_ms >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_at timestamptz not null default statement_timestamp(),
  constraint mail_decision_verdicts_message_fk foreign key (org_id, message_id)
    references messages (org_id, id) on delete cascade,
  constraint mail_decision_verdicts_thread_fk foreign key (org_id, thread_id)
    references threads (org_id, id) on delete cascade,
  constraint mail_decision_verdicts_one_per_message unique (org_id, message_id),
  constraint mail_decision_verdicts_decided_shape check (
    outcome <> 'decided' or (verdict is not null and reason is null)
  ),
  constraint mail_decision_verdicts_reason_shape check (
    outcome = 'decided' or (reason is not null and action_taken = 'none')
  ),
  constraint mail_decision_verdicts_probability_shape check (
    jsonb_typeof(verdict_probabilities) = 'object'
    and jsonb_typeof(category_probabilities) = 'object'
    and jsonb_typeof(urgency_probabilities) = 'object'
  )
);

create index mail_decision_verdicts_org_created_idx
  on mail_decision_verdicts (org_id, created_at desc);

alter table mail_decision_verdicts enable row level security;
alter table mail_decision_verdicts force row level security;
create policy helix_tenant_isolation on mail_decision_verdicts
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on mail_decision_verdicts as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());

-- Feedback rows written when enforce mode files a message as spam, and the
-- message-level join used by the decision-model report.
alter table mail_spam_feedback drop constraint mail_spam_feedback_source_check;
alter table mail_spam_feedback add constraint mail_spam_feedback_source_check
  check (source in ('user', 'auto_spamd', 'auto_ai', 'auto_rules', 'auto_decision_model'));

create index if not exists mail_spam_feedback_message_idx
  on mail_spam_feedback (org_id, message_id, created_at desc)
  where message_id is not null;
