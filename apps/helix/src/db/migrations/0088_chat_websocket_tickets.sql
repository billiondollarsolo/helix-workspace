-- Short-lived chat upgrade credentials are stored only as SHA-256 digests.
-- The consumed_at predicate makes redemption atomic across replicas.
-- This digest lookup is intentionally global: an upgrade has no tenant context
-- until redemption. Composite foreign keys still bind every result to one org.

create unique index if not exists threads_org_id_id_unique_idx
  on threads (org_id, id);

create table if not exists chat_websocket_tickets (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  org_id uuid not null,
  actor_id uuid not null,
  room_id uuid not null,
  audience text not null check (length(audience) > 0),
  path text not null check (path like '/%'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint chat_websocket_tickets_actor_org_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade,
  constraint chat_websocket_tickets_room_org_fk
    foreign key (org_id, room_id) references threads (org_id, id) on delete cascade,
  constraint chat_websocket_tickets_expiry_check check (expires_at > issued_at)
);

create index if not exists chat_websocket_tickets_expiry_idx
  on chat_websocket_tickets (expires_at);
