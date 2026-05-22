/**
 * Seed ~150 plain-upload Drive files distributed across the folder tree.
 * Objects: f000 group
 * Versions: f100 group
 */

import {
  ADMIN_ACTOR,
  FOLDER,
  WORKSPACE_SEED_LARGE_SOURCE,
  daysFromNow,
  grantBoth,
  json,
  sha,
  uid,
  type SeedSql,
} from "./config.js";

interface FileDef {
  readonly idx: number;
  readonly name: string;
  readonly folderId: string;
  readonly mime: string;
  readonly kb: number;
  readonly daysAgo: number;
}

// ---------------------------------------------------------------------------
// File definitions — 150 files across the folder tree.
// ---------------------------------------------------------------------------

const FILES: readonly FileDef[] = [
  // Engineering / backend (idx 1-20)
  { idx: 1,  name: "API spec v1.yaml",               folderId: FOLDER.backend,    mime: "application/yaml",                  kb: 48,    daysAgo: 5  },
  { idx: 2,  name: "API spec v2-draft.yaml",          folderId: FOLDER.backend,    mime: "application/yaml",                  kb: 62,    daysAgo: 2  },
  { idx: 3,  name: "ERD-v3.png",                      folderId: FOLDER.backend,    mime: "image/png",                         kb: 920,   daysAgo: 14 },
  { idx: 4,  name: "ERD-v4.png",                      folderId: FOLDER.backend,    mime: "image/png",                         kb: 1100,  daysAgo: 3  },
  { idx: 5,  name: "service-diagram.svg",              folderId: FOLDER.backend,    mime: "image/svg+xml",                     kb: 28,    daysAgo: 8  },
  { idx: 6,  name: "auth-flow.png",                   folderId: FOLDER.backend,    mime: "image/png",                         kb: 450,   daysAgo: 10 },
  { idx: 7,  name: "postman-collection.json",          folderId: FOLDER.backend,    mime: "application/json",                  kb: 180,   daysAgo: 7  },
  { idx: 8,  name: "migration-notes-2026-05.md",      folderId: FOLDER.backend,    mime: "text/markdown",                     kb: 12,    daysAgo: 2  },
  { idx: 9,  name: "benchmark-results-q2.csv",         folderId: FOLDER.backend,    mime: "text/csv",                          kb: 34,    daysAgo: 6  },
  { idx: 10, name: "database-schema.png",             folderId: FOLDER.backend,    mime: "image/png",                         kb: 780,   daysAgo: 20 },
  { idx: 11, name: "load-test-report-may.pdf",        folderId: FOLDER.backend,    mime: "application/pdf",                   kb: 240,   daysAgo: 4  },
  { idx: 12, name: "api-changelog.txt",               folderId: FOLDER.backend,    mime: "text/plain",                        kb: 22,    daysAgo: 1  },
  { idx: 13, name: "sequence-diagram-mail.svg",       folderId: FOLDER.backend,    mime: "image/svg+xml",                     kb: 34,    daysAgo: 12 },
  { idx: 14, name: "error-codes-reference.pdf",       folderId: FOLDER.backend,    mime: "application/pdf",                   kb: 88,    daysAgo: 9  },
  { idx: 15, name: "k6-stress-test.js",               folderId: FOLDER.backend,    mime: "text/javascript",                   kb: 14,    daysAgo: 5  },
  { idx: 16, name: "caching-strategy.png",            folderId: FOLDER.backend,    mime: "image/png",                         kb: 390,   daysAgo: 11 },
  { idx: 17, name: "tRPC-types.d.ts",                 folderId: FOLDER.backend,    mime: "text/typescript",                   kb: 56,    daysAgo: 3  },
  { idx: 18, name: "feature-flags-export.json",       folderId: FOLDER.backend,    mime: "application/json",                  kb: 8,     daysAgo: 1  },
  { idx: 19, name: "pr-482-diff.patch",               folderId: FOLDER.backend,    mime: "text/plain",                        kb: 18,    daysAgo: 0  },
  { idx: 20, name: "outbox-design.pdf",               folderId: FOLDER.backend,    mime: "application/pdf",                   kb: 132,   daysAgo: 30 },

  // Engineering / frontend (idx 21-35)
  { idx: 21, name: "ui-component-inventory.xlsx",     folderId: FOLDER.frontend,   mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 64,  daysAgo: 7  },
  { idx: 22, name: "bundle-analysis.html",            folderId: FOLDER.frontend,   mime: "text/html",                         kb: 380,   daysAgo: 4  },
  { idx: 23, name: "storybook-export.zip",            folderId: FOLDER.frontend,   mime: "application/zip",                   kb: 4200,  daysAgo: 14 },
  { idx: 24, name: "lighthouse-audit-may.json",       folderId: FOLDER.frontend,   mime: "application/json",                  kb: 92,    daysAgo: 2  },
  { idx: 25, name: "web-vitals-dashboard.png",        folderId: FOLDER.frontend,   mime: "image/png",                         kb: 560,   daysAgo: 6  },
  { idx: 26, name: "react-query-migration.md",        folderId: FOLDER.frontend,   mime: "text/markdown",                     kb: 24,    daysAgo: 9  },
  { idx: 27, name: "keyboard-shortcuts-design.png",   folderId: FOLDER.frontend,   mime: "image/png",                         kb: 730,   daysAgo: 5  },
  { idx: 28, name: "tailwind-config.json",            folderId: FOLDER.frontend,   mime: "application/json",                  kb: 6,     daysAgo: 21 },
  { idx: 29, name: "e2e-test-results.xml",            folderId: FOLDER.frontend,   mime: "application/xml",                   kb: 44,    daysAgo: 1  },
  { idx: 30, name: "accessibility-audit-q2.pdf",      folderId: FOLDER.frontend,   mime: "application/pdf",                   kb: 196,   daysAgo: 8  },
  { idx: 31, name: "state-machine-diagram.svg",       folderId: FOLDER.frontend,   mime: "image/svg+xml",                     kb: 42,    daysAgo: 11 },
  { idx: 32, name: "router-architecture.png",         folderId: FOLDER.frontend,   mime: "image/png",                         kb: 480,   daysAgo: 18 },
  { idx: 33, name: "dark-mode-prototype.mp4",         folderId: FOLDER.frontend,   mime: "video/mp4",                         kb: 22400, daysAgo: 12 },
  { idx: 34, name: "color-tokens-v2.json",            folderId: FOLDER.frontend,   mime: "application/json",                  kb: 12,    daysAgo: 3  },
  { idx: 35, name: "typescript-upgrade-notes.md",     folderId: FOLDER.frontend,   mime: "text/markdown",                     kb: 16,    daysAgo: 25 },

  // Engineering / infra (idx 36-50)
  { idx: 36, name: "k8s-cluster-config.yaml",         folderId: FOLDER.infra,      mime: "application/yaml",                  kb: 38,    daysAgo: 5  },
  { idx: 37, name: "terraform-modules.zip",           folderId: FOLDER.infra,      mime: "application/zip",                   kb: 8400,  daysAgo: 18 },
  { idx: 38, name: "grafana-dashboard-export.json",   folderId: FOLDER.infra,      mime: "application/json",                  kb: 320,   daysAgo: 6  },
  { idx: 39, name: "network-topology.png",            folderId: FOLDER.infra,      mime: "image/png",                         kb: 1240,  daysAgo: 35 },
  { idx: 40, name: "storage-tier-cost-analysis.xlsx", folderId: FOLDER.infra,      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 88, daysAgo: 10 },
  { idx: 41, name: "postgres-upgrade-plan.pdf",       folderId: FOLDER.infra,      mime: "application/pdf",                   kb: 160,   daysAgo: 45 },
  { idx: 42, name: "redis-cluster-migration.md",      folderId: FOLDER.infra,      mime: "text/markdown",                     kb: 28,    daysAgo: 22 },
  { idx: 43, name: "incident-runbook-v2.pdf",         folderId: FOLDER.infra,      mime: "application/pdf",                   kb: 240,   daysAgo: 4  },
  { idx: 44, name: "pagerduty-schedule.csv",          folderId: FOLDER.infra,      mime: "text/csv",                          kb: 14,    daysAgo: 2  },
  { idx: 45, name: "backup-verification-may.txt",     folderId: FOLDER.infra,      mime: "text/plain",                        kb: 8,     daysAgo: 0  },
  { idx: 46, name: "cloudwatch-alarms.json",          folderId: FOLDER.infra,      mime: "application/json",                  kb: 44,    daysAgo: 7  },
  { idx: 47, name: "ci-pipeline-diagram.svg",         folderId: FOLDER.infra,      mime: "image/svg+xml",                     kb: 32,    daysAgo: 14 },
  { idx: 48, name: "security-audit-q1.pdf",           folderId: FOLDER.security,   mime: "application/pdf",                   kb: 520,   daysAgo: 55 },
  { idx: 49, name: "pentest-report-may.pdf",          folderId: FOLDER.security,   mime: "application/pdf",                   kb: 880,   daysAgo: 12 },
  { idx: 50, name: "soc2-evidence-export.zip",        folderId: FOLDER.security,   mime: "application/zip",                   kb: 12000, daysAgo: 3  },

  // Product / roadmap (idx 51-65)
  { idx: 51, name: "Q3-roadmap-v1.pdf",               folderId: FOLDER.roadmap,    mime: "application/pdf",                   kb: 380,   daysAgo: 7  },
  { idx: 52, name: "Q3-roadmap-v2.pdf",               folderId: FOLDER.roadmap,    mime: "application/pdf",                   kb: 404,   daysAgo: 2  },
  { idx: 53, name: "competitor-screenshots.zip",      folderId: FOLDER.roadmap,    mime: "application/zip",                   kb: 9800,  daysAgo: 14 },
  { idx: 54, name: "feature-priority-matrix.xlsx",    folderId: FOLDER.roadmap,    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 44, daysAgo: 5 },
  { idx: 55, name: "okr-q3-tracking.csv",             folderId: FOLDER.roadmap,    mime: "text/csv",                          kb: 12,    daysAgo: 0  },
  { idx: 56, name: "user-interview-recordings.zip",   folderId: FOLDER.research,   mime: "application/zip",                   kb: 840000,daysAgo: 8  },
  { idx: 57, name: "survey-raw-data.csv",             folderId: FOLDER.research,   mime: "text/csv",                          kb: 88,    daysAgo: 11 },
  { idx: 58, name: "affinity-map.png",                folderId: FOLDER.research,   mime: "image/png",                         kb: 2800,  daysAgo: 6  },
  { idx: 59, name: "nps-analysis-may.xlsx",           folderId: FOLDER.research,   mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 56, daysAgo: 3 },
  { idx: 60, name: "enterprise-pilot-recordings.zip", folderId: FOLDER.research,   mime: "application/zip",                   kb: 1200000,daysAgo: 9 },
  { idx: 61, name: "jtbd-workshop-notes.pdf",         folderId: FOLDER.research,   mime: "application/pdf",                   kb: 320,   daysAgo: 20 },
  { idx: 62, name: "heatmap-drive-browser.png",       folderId: FOLDER.ux,         mime: "image/png",                         kb: 1840,  daysAgo: 4  },
  { idx: 63, name: "usability-test-clips.mp4",        folderId: FOLDER.ux,         mime: "video/mp4",                         kb: 48000, daysAgo: 7  },
  { idx: 64, name: "session-recording-export.zip",    folderId: FOLDER.ux,         mime: "application/zip",                   kb: 52000, daysAgo: 5  },
  { idx: 65, name: "persona-workshop-photos.zip",     folderId: FOLDER.ux,         mime: "application/zip",                   kb: 14000, daysAgo: 10 },

  // Design (idx 66-80)
  { idx: 66, name: "helix-icons-v2.zip",              folderId: FOLDER.design,     mime: "application/zip",                   kb: 2400,  daysAgo: 12 },
  { idx: 67, name: "design-tokens.json",              folderId: FOLDER.design,     mime: "application/json",                  kb: 18,    daysAgo: 4  },
  { idx: 68, name: "figma-export-drive-browser.zip",  folderId: FOLDER.design,     mime: "application/zip",                   kb: 18000, daysAgo: 3  },
  { idx: 69, name: "figma-export-assistant.zip",      folderId: FOLDER.design,     mime: "application/zip",                   kb: 22000, daysAgo: 5  },
  { idx: 70, name: "component-screenshots.zip",       folderId: FOLDER.design,     mime: "application/zip",                   kb: 8400,  daysAgo: 9  },
  { idx: 71, name: "logo-master.svg",                 folderId: FOLDER.brand,      mime: "image/svg+xml",                     kb: 14,    daysAgo: 45 },
  { idx: 72, name: "logo-variations.zip",             folderId: FOLDER.brand,      mime: "application/zip",                   kb: 3200,  daysAgo: 45 },
  { idx: 73, name: "brand-colors.ase",                folderId: FOLDER.brand,      mime: "application/octet-stream",          kb: 4,     daysAgo: 60 },
  { idx: 74, name: "product-screenshots-may.zip",     folderId: FOLDER.brand,      mime: "application/zip",                   kb: 24000, daysAgo: 2  },
  { idx: 75, name: "brand-deck-2026.pdf",             folderId: FOLDER.brand,      mime: "application/pdf",                   kb: 6800,  daysAgo: 30 },

  // Finance (idx 76-90)
  { idx: 76, name: "may-invoices.zip",                folderId: FOLDER.finance,    mime: "application/zip",                   kb: 2200,  daysAgo: 1  },
  { idx: 77, name: "april-invoices.zip",              folderId: FOLDER.finance,    mime: "application/zip",                   kb: 1800,  daysAgo: 32 },
  { idx: 78, name: "q2-budget-actuals.xlsx",          folderId: FOLDER.finance,    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 144, daysAgo: 5 },
  { idx: 79, name: "fy2026-forecast.xlsx",            folderId: FOLDER.finance,    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 212, daysAgo: 45 },
  { idx: 80, name: "northwind-renewal-draft.pdf",     folderId: FOLDER.contracts,  mime: "application/pdf",                   kb: 188,   daysAgo: 6  },
  { idx: 81, name: "acme-corp-msa.pdf",               folderId: FOLDER.contracts,  mime: "application/pdf",                   kb: 340,   daysAgo: 25 },
  { idx: 82, name: "vendor-nda-template.docx",        folderId: FOLDER.contracts,  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kb: 44, daysAgo: 90 },
  { idx: 83, name: "cloudsupplier-renewal.pdf",       folderId: FOLDER.contracts,  mime: "application/pdf",                   kb: 260,   daysAgo: 8  },
  { idx: 84, name: "payroll-q1-summary.pdf",          folderId: FOLDER.payroll,    mime: "application/pdf",                   kb: 180,   daysAgo: 55 },
  { idx: 85, name: "payroll-q2-summary.pdf",          folderId: FOLDER.payroll,    mime: "application/pdf",                   kb: 188,   daysAgo: 5  },
  { idx: 86, name: "equity-refresh-2026.xlsx",        folderId: FOLDER.payroll,    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 96, daysAgo: 30 },

  // Marketing (idx 87-110)
  { idx: 87, name: "enterprise-launch-brief.pdf",     folderId: FOLDER.marketing,  mime: "application/pdf",                   kb: 240,   daysAgo: 4  },
  { idx: 88, name: "devconf-slide-deck.pdf",          folderId: FOLDER.marketing,  mime: "application/pdf",                   kb: 3200,  daysAgo: 6  },
  { idx: 89, name: "press-release-draft.docx",        folderId: FOLDER.marketing,  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kb: 36, daysAgo: 3 },
  { idx: 90, name: "media-kit.zip",                   folderId: FOLDER.marketing,  mime: "application/zip",                   kb: 28000, daysAgo: 20 },
  { idx: 91, name: "june-campaign-brief.pdf",         folderId: FOLDER.campaigns,  mime: "application/pdf",                   kb: 180,   daysAgo: 5  },
  { idx: 92, name: "linkedin-creatives.zip",          folderId: FOLDER.campaigns,  mime: "application/zip",                   kb: 6400,  daysAgo: 3  },
  { idx: 93, name: "email-campaign-template.html",    folderId: FOLDER.campaigns,  mime: "text/html",                         kb: 28,    daysAgo: 4  },
  { idx: 94, name: "ad-copy-variants.csv",            folderId: FOLDER.campaigns,  mime: "text/csv",                          kb: 18,    daysAgo: 2  },
  { idx: 95, name: "case-study-northwind.pdf",        folderId: FOLDER.content,    mime: "application/pdf",                   kb: 480,   daysAgo: 8  },
  { idx: 96, name: "blog-post-formula-engine.md",     folderId: FOLDER.content,    mime: "text/markdown",                     kb: 14,    daysAgo: 5  },
  { idx: 97, name: "product-demo-video.mp4",          folderId: FOLDER.content,    mime: "video/mp4",                         kb: 96000, daysAgo: 7  },
  { idx: 98, name: "webinar-recording.mp4",           folderId: FOLDER.content,    mime: "video/mp4",                         kb: 420000,daysAgo: 14 },
  { idx: 99, name: "newsletter-may.html",             folderId: FOLDER.content,    mime: "text/html",                         kb: 32,    daysAgo: 0  },
  { idx: 100, name: "content-calendar-jun.xlsx",      folderId: FOLDER.content,    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 44, daysAgo: 1 },

  // People (idx 101-120)
  { idx: 101, name: "employee-handbook-2026.pdf",     folderId: FOLDER.people,     mime: "application/pdf",                   kb: 1840,  daysAgo: 60 },
  { idx: 102, name: "org-chart-may-2026.png",         folderId: FOLDER.people,     mime: "image/png",                         kb: 680,   daysAgo: 2  },
  { idx: 103, name: "benefits-summary-2026.pdf",      folderId: FOLDER.people,     mime: "application/pdf",                   kb: 320,   daysAgo: 90 },
  { idx: 104, name: "offsite-2026-agenda.pdf",        folderId: FOLDER.people,     mime: "application/pdf",                   kb: 96,    daysAgo: 5  },
  { idx: 105, name: "team-photo-2026.jpg",            folderId: FOLDER.people,     mime: "image/jpeg",                        kb: 3800,  daysAgo: 3  },
  { idx: 106, name: "hiring-pipeline-q2.xlsx",        folderId: FOLDER.hiring,     mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 64, daysAgo: 4 },
  { idx: 107, name: "interview-rubric-backend.pdf",   folderId: FOLDER.hiring,     mime: "application/pdf",                   kb: 88,    daysAgo: 7  },
  { idx: 108, name: "offer-letter-template.docx",     folderId: FOLDER.hiring,     mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kb: 36, daysAgo: 45 },
  { idx: 109, name: "headcount-plan-q3.xlsx",         folderId: FOLDER.hiring,     mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kb: 48, daysAgo: 6 },
  { idx: 110, name: "onboarding-checklist.pdf",       folderId: FOLDER.onboarding, mime: "application/pdf",                   kb: 120,   daysAgo: 14 },
  { idx: 111, name: "new-hire-welcome-packet.pdf",    folderId: FOLDER.onboarding, mime: "application/pdf",                   kb: 240,   daysAgo: 14 },
  { idx: 112, name: "it-setup-guide.pdf",             folderId: FOLDER.onboarding, mime: "application/pdf",                   kb: 160,   daysAgo: 60 },

  // Legal (idx 113-125)
  { idx: 113, name: "privacy-policy-2026.pdf",        folderId: FOLDER.legal,      mime: "application/pdf",                   kb: 380,   daysAgo: 60 },
  { idx: 114, name: "terms-of-service-2026.pdf",      folderId: FOLDER.legal,      mime: "application/pdf",                   kb: 440,   daysAgo: 60 },
  { idx: 115, name: "gdpr-compliance-checklist.pdf",  folderId: FOLDER.legal,      mime: "application/pdf",                   kb: 220,   daysAgo: 30 },
  { idx: 116, name: "soc2-policy-doc.pdf",            folderId: FOLDER.legal,      mime: "application/pdf",                   kb: 640,   daysAgo: 8  },
  { idx: 117, name: "dpa-template-eu.pdf",            folderId: FOLDER.legal,      mime: "application/pdf",                   kb: 260,   daysAgo: 20 },

  // Data (idx 118-130)
  { idx: 118, name: "analytics-monthly-report-apr.pdf", folderId: FOLDER.data,    mime: "application/pdf",                   kb: 480,   daysAgo: 22 },
  { idx: 119, name: "dbt-models-export.zip",          folderId: FOLDER.data,       mime: "application/zip",                   kb: 5600,  daysAgo: 7  },
  { idx: 120, name: "snowflake-schema.png",           folderId: FOLDER.data,       mime: "image/png",                         kb: 1200,  daysAgo: 14 },
  { idx: 121, name: "activation-funnel-apr.csv",      folderId: FOLDER.data,       mime: "text/csv",                          kb: 44,    daysAgo: 22 },
  { idx: 122, name: "churn-risk-model-v2.ipynb",      folderId: FOLDER.data,       mime: "application/x-ipynb+json",          kb: 320,   daysAgo: 10 },
  { idx: 123, name: "event-schema-spec.yaml",         folderId: FOLDER.data,       mime: "application/yaml",                  kb: 28,    daysAgo: 18 },
  { idx: 124, name: "monthly-metrics-may.pdf",        folderId: FOLDER.data,       mime: "application/pdf",                   kb: 360,   daysAgo: 1  },

  // Root level (idx 125-130 — miscellaneous)
  { idx: 125, name: "all-hands-deck-may.pdf",         folderId: FOLDER.root,       mime: "application/pdf",                   kb: 2800,  daysAgo: 11 },
  { idx: 126, name: "company-photo-2026.jpg",         folderId: FOLDER.root,       mime: "image/jpeg",                        kb: 4200,  daysAgo: 3  },
  { idx: 127, name: "travel-booking-guide.pdf",       folderId: FOLDER.root,       mime: "application/pdf",                   kb: 96,    daysAgo: 45 },
  { idx: 128, name: "password-manager-setup.pdf",     folderId: FOLDER.root,       mime: "application/pdf",                   kb: 60,    daysAgo: 55 },
  { idx: 129, name: "2fa-enrollment-guide.pdf",       folderId: FOLDER.root,       mime: "application/pdf",                   kb: 48,    daysAgo: 55 },
  { idx: 130, name: "dev-environment-setup.sh",       folderId: FOLDER.root,       mime: "application/x-sh",                  kb: 8,     daysAgo: 30 },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export async function seedDrive(sql: SeedSql, orgId: string): Promise<number> {
  for (const file of FILES) {
    const objectId = uid("f000", file.idx);
    const body     = `Seeded Drive file: ${file.name}`;
    const created  = daysFromNow(-file.daysAgo, 10, file.idx % 60);

    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, created_at, updated_at)
      values (
        ${objectId}, ${orgId}, ${ADMIN_ACTOR}, 'file',
        ${`drive/${orgId}/${objectId}/${file.name}`}, ${file.mime},
        ${file.kb * 1024}, ${sha(body + String(file.idx))},
        ${json(sql, {
          source: WORKSPACE_SEED_LARGE_SOURCE,
          name: file.name,
          folderId: file.folderId,
          status: "ready",
        })},
        ${created}, ${created}
      )
      on conflict (id) do update set
        metadata   = excluded.metadata,
        updated_at = now()
    `;
    await sql`
      insert into drive_versions (id, org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id, created_at)
      values (
        ${uid("f100", file.idx)}, ${orgId}, ${objectId}, 1,
        ${`drive/${orgId}/${objectId}/${file.name}`}, ${file.mime},
        ${file.kb * 1024}, ${sha(body + String(file.idx))},
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE })}, ${ADMIN_ACTOR}, ${created}
      )
      on conflict (id) do nothing
    `;
    await grantBoth(sql, orgId, "object", objectId, "owner");
  }

  return FILES.length;
}
