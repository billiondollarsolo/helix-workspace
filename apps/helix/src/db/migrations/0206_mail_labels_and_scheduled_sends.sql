-- Personal mail labels nest under a parent label and use the fixed display
-- palette (packages/contracts MAIL_LABEL_COLORS). Scheduled sends carry an
-- explicit marker so they list in the Scheduled view rather than as undo-window
-- sends.

create unique index mail_labels_org_id_uidx on mail_labels (org_id, id);

alter table mail_labels
  add column parent_id uuid,
  add constraint mail_labels_parent_fk foreign key (org_id, parent_id)
    references mail_labels (org_id, id) on delete cascade,
  add constraint mail_labels_parent_not_self check (parent_id is null or parent_id <> id);

create index mail_labels_parent_idx on mail_labels (parent_id) where parent_id is not null;

update mail_labels
set color = '#636363', updated_at = now()
where lower(color) not in (
  '#a83634', '#a73b15', '#a14400', '#935200', '#7e5f00', '#6a6800', '#457200', '#00792f',
  '#007c4d', '#007d63', '#007c76', '#007792', '#006fa7', '#1762b6', '#4d57b7', '#6b4cae',
  '#7d45a2', '#8c3f91', '#943b84', '#9e366f', '#a6344f', '#895436', '#50667c', '#636363'
);

alter table mail_labels alter column color set default '#636363';

alter table mail_outbound_messages add column scheduled_for timestamptz;

create index mail_outbound_scheduled_idx
  on mail_outbound_messages (org_id, actor_id, scheduled_for)
  where status = 'queued' and scheduled_for is not null;
