create table meet_transcripts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  room_id uuid not null,
  owner_actor_id uuid not null,
  status text not null default 'capturing' check (status in ('capturing','processing','ready','failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  lease_until timestamptz,
  attempts integer not null default 0,
  error text,
  transcript_object_id uuid references objects(id) on delete set null,
  summary_object_id uuid references objects(id) on delete set null,
  summary_requested boolean not null default false,
  delivery_completed_at timestamptz,
  foreign key (org_id, room_id) references meet_rooms(org_id,id) on delete cascade,
  foreign key (org_id, owner_actor_id) references actors(org_id,id),
  unique (org_id,id)
);
create unique index meet_transcripts_active on meet_transcripts(org_id,room_id) where status='capturing';
create table meet_transcript_segments (
  org_id uuid not null,
  transcript_id uuid not null,
  segment_id text not null,
  speaker text not null check(length(speaker) <= 200),
  spoken_at timestamptz not null,
  body text not null check(length(body) between 1 and 16000),
  primary key(org_id,transcript_id,segment_id),
  foreign key(org_id,transcript_id) references meet_transcripts(org_id,id) on delete cascade
);
alter table meet_transcripts enable row level security;
alter table meet_transcripts force row level security;
create policy helix_tenant_isolation on meet_transcripts using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
alter table meet_transcript_segments enable row level security;
alter table meet_transcript_segments force row level security;
create policy helix_tenant_isolation on meet_transcript_segments using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
revoke all on meet_transcripts, meet_transcript_segments from public, helix_readonly;
grant select,insert,update,delete on meet_transcripts, meet_transcript_segments to helix_app,helix_worker;

create function helix_meet_transcript_work_orgs(batch_limit integer) returns table(org_id uuid)
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
begin
  if batch_limit not between 1 and 100 then raise exception 'Invalid transcript batch'; end if;
  if nullif(current_setting('helix.org_id',true),'') is not null or nullif(current_setting('helix.actor_id',true),'') is not null then
    raise exception 'Transcript discovery is restricted to the worker';
  end if;
  return query select distinct t.org_id from meet_transcripts t
    where (t.status='processing' and (t.lease_until is null or t.lease_until < now()))
      or (t.status='capturing' and t.heartbeat_at < now()-interval '1 minute')
    limit batch_limit;
end $$;
revoke all on function helix_meet_transcript_work_orgs(integer) from public,helix_app,helix_readonly;
grant execute on function helix_meet_transcript_work_orgs(integer) to helix_worker;
