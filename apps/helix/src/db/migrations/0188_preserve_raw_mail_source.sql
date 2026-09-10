-- Raw mail source bytes and metadata are immutable evidence. Classification
-- projection applies to mutable objects and must never rewrite raw sources.
drop trigger objects_inherit_sensitivity on objects;
create trigger objects_inherit_sensitivity
  after insert or update of metadata on objects
  for each row when (new.kind::text <> 'mail_source')
  execute function helix_inherit_object_sensitivity();
