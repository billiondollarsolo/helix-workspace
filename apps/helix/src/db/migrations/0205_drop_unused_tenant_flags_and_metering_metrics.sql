-- Tenant feature flags: strip keys nothing reads from stored org config.
--   * ai_smart_compose, dlp_enforcement and watermark governed no feature:
--     there is no compose assist, DLP is configured by the `dlp` security
--     policy, and nothing renders watermarks.
--   * b2b_sharing, byo_*, sso_saml, scim_provisioning, custom_domain,
--     white_label, multi_region_dr, dedicated_csm, marketplace_install_paid
--     and support_tier were plan entitlements. Only orgs.feature_flags is
--     touched; the custom_domain branding field in orgs.branding stays.
-- The tenant config audit trigger records each changed org under this reason.
select set_config('helix.tenant_config_reason', 'migration: drop unused tenant feature flags', true);

update orgs
set feature_flags = (
  select coalesce(jsonb_object_agg(flag.key, flag.value), '{}'::jsonb)
  from jsonb_each(orgs.feature_flags) flag
  where flag.key not in (
      'ai_smart_compose', 'dlp_enforcement', 'watermark',
      'b2b_sharing', 'sso_saml', 'scim_provisioning', 'custom_domain', 'white_label',
      'multi_region_dr', 'dedicated_csm', 'marketplace_install_paid', 'support_tier'
    )
    and flag.key not like 'byo\_%'
)
where feature_flags ?| array[
    'ai_smart_compose', 'dlp_enforcement', 'watermark',
    'b2b_sharing', 'sso_saml', 'scim_provisioning', 'custom_domain', 'white_label',
    'multi_region_dr', 'dedicated_csm', 'marketplace_install_paid', 'support_tier'
  ]
  or exists (select 1 from jsonb_object_keys(feature_flags) key where key like 'byo\_%');

select set_config('helix.tenant_config_reason', '', true);

-- Usage metering keeps AI tokens and images, storage and exports. Seat counts
-- were a billing concept, `api.call.billable` and `collab.session.opened` had
-- no emitter after the editor was removed. Drop their events and rollups.
delete from metering_events
where event_type in ('seats.delta', 'api.call.billable', 'collab.session.opened');

delete from metering_rollups
where metric_key in ('seats_delta', 'seats_max', 'api_calls_billable', 'collab_session_seconds');
