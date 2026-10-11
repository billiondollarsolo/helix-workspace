-- Thumbs up/down feedback on Assistant answers, one rating per person and
-- answer, with an optional comment. Rows follow the tenant RLS contract every
-- org_id table carries; the application scopes them to the conversation owner.

create table assistant_message_feedback (
  org_id uuid not null,
  message_id uuid not null references assistant_messages(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  rating text not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, actor_id),
  constraint assistant_message_feedback_rating_check check (rating in ('up', 'down')),
  constraint assistant_message_feedback_comment_check
    check (comment is null or char_length(comment) between 1 and 2000)
);

create index assistant_message_feedback_actor_idx
  on assistant_message_feedback (org_id, actor_id, updated_at desc);

alter table assistant_message_feedback enable row level security;
alter table assistant_message_feedback force row level security;

create policy helix_tenant_isolation on assistant_message_feedback
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create policy helix_tenant_boundary on assistant_message_feedback as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
