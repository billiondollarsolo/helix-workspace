create table if not exists drive_pdf_form_states (
  org_id uuid not null references orgs(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  field_values jsonb not null default '[]'::jsonb,
  source_version_number integer,
  source_sha256 text,
  source_byte_size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, object_id, actor_id),
  constraint drive_pdf_form_states_field_values_array
    check (jsonb_typeof(field_values) = 'array'),
  constraint drive_pdf_form_states_source_version_positive
    check (source_version_number is null or source_version_number > 0)
);

create index if not exists drive_pdf_form_states_actor_updated_idx
  on drive_pdf_form_states (org_id, actor_id, updated_at desc);

create index if not exists drive_pdf_form_states_object_updated_idx
  on drive_pdf_form_states (org_id, object_id, updated_at desc);

alter table drive_pdf_form_states enable row level security;

drop policy if exists helix_tenant_isolation on drive_pdf_form_states;
create policy helix_tenant_isolation on drive_pdf_form_states
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
