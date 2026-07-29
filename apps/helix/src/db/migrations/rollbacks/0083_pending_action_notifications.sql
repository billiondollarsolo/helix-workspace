drop trigger if exists pending_actions_notify_state on pending_actions;
drop function if exists notify_pending_action_state();
drop index if exists notifications_pending_action_state_idx;
