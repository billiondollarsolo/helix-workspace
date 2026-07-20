-- GIN index for mention queries over messages.metadata (populated by chat send).
create index if not exists messages_metadata_gin_idx on messages using gin (metadata jsonb_path_ops);
