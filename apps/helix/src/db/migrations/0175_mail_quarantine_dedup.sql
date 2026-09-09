alter table mail_quarantines add column dedup_key text;
create unique index mail_quarantines_org_dedup_idx
  on mail_quarantines (org_id, dedup_key) where dedup_key is not null;
