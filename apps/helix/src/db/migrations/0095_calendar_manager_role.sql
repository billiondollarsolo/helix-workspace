-- Calendar writers may create events; managers additionally govern the
-- calendar and its membership. Keep this distinction in the closed enum.
alter type cal_membership_role add value if not exists 'manager' after 'owner';
