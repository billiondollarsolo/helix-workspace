alter table outbox add column if not exists span_id text;
alter table outbox add column if not exists traceparent text;
alter table outbox add column if not exists tracestate text;
