# Admin console — enforce-or-hide inventory (E7.1)

**Audience:** Operators, release reviewers, implementers  
**Normative plan:** [`docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`](./superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md) task E7.1  
**Nav source of truth:** [`apps/web/src/features/admin/admin-console-data.ts`](../apps/web/src/features/admin/admin-console-data.ts)  
**Backend control inventory:** [`apps/helix/src/platform/admin/control-inventory.ts`](../apps/helix/src/platform/admin/control-inventory.ts)  
**Policy runtime modes:** [`apps/helix/src/platform/admin/security-policy-runtime.ts`](../apps/helix/src/platform/admin/security-policy-runtime.ts)  
**Date:** 2026-08-03

## Status legend

| Status              | Meaning                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **enforced**        | Live UI + API (or tools) and a runtime path that actually constrains requests or data.                                                |
| **UI+API**          | Live admin UI wired to real endpoints/tools; operator can read/mutate configuration or inventory. Not every field is a security gate. |
| **runtime_pending** | Config or test hooks exist, but the runtime login/enforcement path is incomplete. UI must not claim full protection.                  |
| **gated**           | Hidden from nav (and route-param rejected) unless an explicit build flag enables it.                                                  |

Honesty rule: never label a control “Required” / “Protected” when runtime mode is `recorded_only` or test-login returns `runtime_pending`. Prefer hide, disable-with-reason, or an honest “Recorded” chip.

---

## Section inventory (sidebar order)

Sections and ids match `ADMIN_NAV_ROOT` + `ADMIN_NAV_GROUPS` in `admin-console-data.ts`. Wiring map: `SECTION_CONTENT` in `admin-console.tsx`.

| Section id           | Label                    | Group               | Status               | Evidence (code)                                                                                                                           | Notes                                                                                                                                                                                                                       |
| -------------------- | ------------------------ | ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`           | Overview                 | (root)              | UI+API               | `sections/overview.tsx` — live queries only (`admin/users`, domains, security-policies, core-apps, platform config)                       | Aggregates other sections’ cache keys; never invents “all green” without responses. Not a security enforcer.                                                                                                                |
| `domains`            | Domains                  | Organization        | UI+API               | `sections/domains.tsx`, `domains-api.ts` → `/api/admin/domains` (+ DNS verify/challenge)                                                  | Create/list/primary/DNS verify are live. Continuous monitoring/alerts remain partial (`control-inventory` `domains.dns`).                                                                                                   |
| `billing`            | Billing & usage          | Organization        | **gated**            | `admin-console-data.ts` `DISABLED_SECTIONS` when `VITE_HELIX_BILLING_ENABLED !== "true"`; `sections/billing.tsx` → `/api/admin/billing/*` | Self-host default: nav hidden and `/admin/billing` treated as unknown. Hosted builds opt in with the Vite flag. No payment-gateway integration in the API client.                                                           |
| `workspace-settings` | Workspace settings       | Organization        | UI+API               | `tenant-config-management.tsx` → `/api/admin/tenant-config`                                                                               | Feature flags, branding, BYO storage test/migration. Some flags (e.g. DLP enforcement levels) store intent consumed only where platform supports it — see Policies for DLP honesty.                                         |
| `users`              | Users                    | People              | UI+API               | `sections/users.tsx`, `admin-users.tsx` → `/api/admin/users`                                                                              | Directory list/filter/export from live actors. Role display derives from scopes (`roleForActor`). Full invite/suspend mutation UX is incomplete relative to E7.2 offboarding goals — do not claim offboard-complete here.   |
| `groups`             | Groups & org units       | People              | UI+API               | `sections/groups.tsx`, `groups-api.ts` → `/api/admin/groups`, `/api/admin/org-units`                                                      | CRUD + membership mutations live and org-scoped.                                                                                                                                                                            |
| `policies`           | Policies                 | Security            | mixed → see subtable | `sections/policies.tsx`, `security-policies-api.ts`, `security-policy-runtime.ts`                                                         | UI refuses Required for recorded-only types; chips prefer `runtimeStatus`.                                                                                                                                                  |
| `identity`           | Identity & SSO           | Security            | **runtime_pending**  | `identity-management.tsx`, `identity-api.ts` → `/api/admin/identity/idp-configs`; test-login → `runtime_pending`                          | IdP configs + SP metadata are live; ACS/OIDC login enforcement incomplete. Test login never implies SSO is production-ready. SCIM: read/config partial; mutations 501 until complete (`control-inventory` `identity.scim`). |
| `tier-readiness`     | Tier readiness           | Security            | UI+API               | `security-tier-readiness.tsx`, `tier-readiness/*`                                                                                         | Platform config + plugin catalogue; gates are advisory to operators, not a substitute for production assert boot.                                                                                                           |
| `audit`              | Audit log                | Security            | enforced             | `audit-log.tsx` → `/api/admin/audit-log`; append path via `auditAdminAction`                                                              | Immutable hash chain store; admin mutations audited.                                                                                                                                                                        |
| `workspace-apps`     | Workspace apps           | Apps & integrations | UI+API               | `core-apps-management.tsx` → `/api/admin/core-apps`                                                                                       | Org enablement toggles + packaging allowlist. Production MVP still fail-closes on `HELIX_APPS` / profile assertions.                                                                                                        |
| `mail`               | Mail                     | Apps & integrations | UI+API               | `mail-admin.tsx`, `mail-admin-api.ts` → `/api/admin/mail/*`                                                                               | Providers, sending/receiving domains, routing, spam config. Delivery reputation is external (managed provider).                                                                                                             |
| `chat`               | Chat                     | Apps & integrations | enforced             | `chat-admin.tsx`, tools `chat.retention.*`, `chat.legal_hold.set`, `chat.export.organization`                                             | Retention / legal hold / export use real tools with confirmation; missing tools disable with reason.                                                                                                                        |
| `drive`              | Drive                    | Apps & integrations | UI+API               | `drive-admin.tsx`, tools `drive.quota.usage`, `drive.lifecycle.*`                                                                         | Quota usage + lifecycle policy. Malware fail-closed is runtime on upload finalize/scan worker, not this panel alone.                                                                                                        |
| `oauth-apps`         | OAuth apps               | Apps & integrations | enforced             | `sections/oauth-apps.tsx` → `/api/admin/oauth-apps`                                                                                       | List/status/revoke audited.                                                                                                                                                                                                 |
| `app-passwords`      | App passwords            | Apps & integrations | enforced             | `app-passwords-management.tsx` + app-password tools                                                                                       | Create/list/revoke with scopes; Basic auth uses hashed secrets.                                                                                                                                                             |
| `agent-credentials`  | Agent credentials        | Apps & integrations | enforced             | `agent-credentials-management.tsx` + credential tools                                                                                     | Create/revoke; credential policy enforced on tool surfaces.                                                                                                                                                                 |
| `agent-controls`     | Agent emergency controls | Apps & integrations | enforced             | `agent-controls.tsx` → agent operational controls API                                                                                     | Emergency kill (global read-only) and agent-write disable take effect for non-read tools immediately.                                                                                                                       |
| `webhooks`           | Webhooks                 | Apps & integrations | UI+API               | `features/webhooks/webhook-management`                                                                                                    | Live webhook management surface (admin nav entry).                                                                                                                                                                          |
| `ai-costs`           | Cost limits              | AI                  | enforced             | `ai-cost-limits-management.tsx` → `/api/admin/ai/cost-limits`                                                                             | Per-actor limits applied by AI cost enforcement paths.                                                                                                                                                                      |
| `ai-observability`   | Observability            | AI                  | UI+API               | `ai-observability.tsx` (platform config projection)                                                                                       | Read-only cost/audit/privacy config view for operators.                                                                                                                                                                     |
| `services`           | Services                 | Platform            | UI+API               | `admin-services.tsx`                                                                                                                      | Dependency/status rollup from live admin service probes.                                                                                                                                                                    |

---

## Policies section — per-control honesty

Source: `SECURITY_POLICY_RUNTIME_CAPABILITIES` in `security-policy-runtime.ts`. Admin UI maps `runtimeStatus.displayLevel` so stored `enforcement=required` never shows as **Required** when mode is `recorded_only`.

| Policy type        | Runtime mode  | Operator-facing status     | Enforcement points (when any)                                                                                                                                                                                                 |
| ------------------ | ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfa`              | partial       | UI+API (partial enforced)  | Admin-scoped `/api/admin/*` via `evaluateOrgAdminMfa` when policy required or tier requires admin MFA. End-user sign-in MFA not fully platform-gated. Business also depends on upstream signed MFA assertions at deploy time. |
| `sso`              | recorded_only | **runtime_pending**        | No login enforcement that disables local password login. Test-login API returns `runtime_pending` / `configuration_required`.                                                                                                 |
| `session`          | partial       | UI+API (partial)           | Absolute lifetime helper from `inactivityTimeoutDays`; idle reaping / concurrent caps not fully enforced.                                                                                                                     |
| `external_sharing` | enforced      | **enforced**               | Drive share links / email share targets (`drive.link.create`, share email allowlist).                                                                                                                                         |
| `dlp`              | recorded_only | runtime_pending / recorded | Stored + audited only; no content scan gate yet.                                                                                                                                                                              |
| `device_trust`     | recorded_only | runtime_pending / recorded | Stored + audited only; no managed-device check yet.                                                                                                                                                                           |

SSO test control: `POST /api/admin/security-policies/sso/test-login` and IdP `…/test-login` are readiness probes, not proof of production ACS.

---

## Build-time gating

| Control         | Mechanism                                                                                                  | Default pilot                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Billing section | `VITE_HELIX_BILLING_ENABLED === "true"` else section id in `DISABLED_SECTIONS`; `isAdminSectionId` rejects | Hidden                           |
| MVP apps        | `HELIX_APPS`, `VITE_HELIX_MVP_ONLY`, server packaging assertions                                           | `mail,drive,chat,assistant` only |

---

## Gaps tracked for later E7 tasks (not deceptive today if UI stays honest)

| Gap                                       | Related task | Current honesty                                     |
| ----------------------------------------- | ------------ | --------------------------------------------------- |
| SSO/SAML/OIDC full ACS + required-SSO     | E7.3         | `runtime_pending` / recorded_only; Required blocked |
| SCIM write provisioning                   | E7.3         | Partial; mutations 501                              |
| Users invite / suspend / offboard cascade | E7.2         | Directory UI+API; cascade not claimed complete      |
| Audit export + retention display polish   | E7.4         | Search/list enforced; export depth TBD              |
| DLP / device trust runtime                | future       | Recorded chips only                                 |

---

## Review checklist (E7.1 acceptance)

- [x] Every nav section from `admin-console-data.ts` listed with a status.
- [x] Billing remains gated unless hosted flag.
- [x] SSO surfaces classified `runtime_pending`, not “enforced”.
- [x] Security policies that lack runtime points documented as recorded / partial.
- [ ] Any future control that stores “enabled” without a consumer must either gain enforcement tests or be hidden/disabled-with-reason (ongoing gate).

**Evidence path for plan artifact:** promote or symlink this file as `E7/enforce-or-hide.md` in the release evidence layout when collecting E7 packets.
