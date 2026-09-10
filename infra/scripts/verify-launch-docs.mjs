#!/usr/bin/env node

import console from "node:console";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(
  process.env.HELIX_WORKSPACE_DIR ?? join(scriptDirectory, "../.."),
);

export const launchDocumentPaths = [
  "README.md",
  "docs/admin-guide.md",
  "docs/security/threat-model.md",
];

export const scopeDocumentPath = "docs/release/1.0-scope.md";
export const scopeConsumerPaths = [
  "README.md",
  "docs/product-claims-mvp.md",
  "docs/final-release-readiness.md",
];

export const adrPaths = [
  "docs/adr/adr-0001-single-organization-business-pilot.md",
  "docs/adr/adr-0002-managed-outbound-mail-provider.md",
  "docs/adr/adr-0003-web-and-api-mail-clients.md",
  "docs/adr/adr-0004-secure-server-readable-chat.md",
  "docs/adr/adr-0005-agent-write-confirmation-and-allowlists.md",
  "docs/adr/adr-0006-business-pilot-recovery-targets.md",
  "docs/adr/adr-0007-fail-closed-untrusted-uploads.md",
];

export const requiredClaimPatterns = [
  {
    id: "single-organization Business pilot",
    pattern: /one organization\s+with 5[–-]50 trusted users[\s\S]{0,100}\bbusiness\b/iu,
  },
  {
    id: "managed outbound provider",
    pattern: /supported managed outbound email provider/iu,
  },
  {
    id: "no direct-to-MX launch operation",
    pattern: /(?:does not|do not|will not)[^.]{0,100}\bdirect-to-MX\b/iu,
  },
  {
    id: "no Helix-hosted IMAP server",
    pattern:
      /(?:does not include|do not include|does not provide or imply)[^.]{0,100}\bHelix-hosted IMAP server\b/iu,
  },
  {
    id: "chat is not E2EE",
    pattern: /chat is\s+\*\*not end-to-end encrypted\*\*/iu,
  },
  {
    id: "server administrators can access stored chat",
    pattern:
      /authorized\s+server\s+administrators\s+can\s+technically\s+access\s+stored\s+(?:chat\s+)?messages/iu,
  },
  {
    id: "agent writes require confirmation by default",
    pattern:
      /(?:(?:every\s+)?agent\s+writes?\s+(?:requires?|require)[\s\S]{0,100}confirmation\s+by\s+default|require[\s\S]{0,100}confirmation[\s\S]{0,100}every\s+agent\s+write\s+by\s+default)/iu,
  },
  {
    id: "automation policies are bounded",
    pattern:
      /automation policy[\s\S]{0,140}\b(?:action|tool)\b[\s\S]{0,140}\bresource\b[\s\S]{0,140}\btarget\b[\s\S]{0,140}\b(?:time window|expiry)\b[\s\S]{0,140}\brate\b/iu,
  },
  {
    id: "untrusted uploads stay unavailable until clean",
    pattern:
      /untrusted[\s\S]{0,40}uploads?[\s\S]{0,160}remain\s+unavailable[\s\S]{0,300}real\s+malware\s+scanner[\s\S]{0,100}clean\s+verdict/iu,
  },
  {
    id: "failed scans remain quarantined",
    pattern:
      /scanner\s+(?:failures?|failure,\s+timeout,\s+or\s+unsupported\s+results|errors\s+and\s+timeouts)[\s\S]{0,100}remain quarantined/iu,
  },
  {
    id: "pilot availability objective",
    pattern: /99\.5% monthly availability/iu,
  },
  {
    id: "pilot RPO",
    pattern: /RPO\s+(?:of\s+no\s+more\s+than|≤)\s*24\s+hours/iu,
  },
  {
    id: "pilot RTO",
    pattern: /RTO\s+(?:of\s+no\s+more\s+than|≤)\s*4\s+hours/iu,
  },
  {
    id: "recovery target is not a contractual SLA",
    pattern: /not a contractual SLA/iu,
  },
];

export const prohibitedClaimPatterns = [
  {
    id: "public multi-tenant SaaS launch readiness",
    pattern: /\bHelix is (?:ready|production-ready) for public multi-tenant SaaS\b/iu,
  },
  {
    id: "Helix-hosted IMAP support",
    pattern: /\bHelix (?:includes|provides|supports|ships|offers) (?:an? )?(?:hosted )?IMAP\b/iu,
  },
  {
    id: "E2EE chat",
    pattern: /\bChat is (?:fully )?end-to-end encrypted\b/iu,
  },
  {
    id: "direct-to-MX launch operation",
    pattern: /\bHelix (?:operates|uses|supports) direct-to-MX\b/iu,
  },
  {
    id: "unconfirmed agent writes",
    pattern: /\bagent writes? (?:execute|run) without (?:human )?confirmation\b/iu,
  },
  {
    id: "fail-open upload scanning",
    pattern: /\buntrusted uploads? (?:are|become) available before (?:malware )?scanning\b/iu,
  },
  {
    id: "stronger pilot availability claim",
    pattern: /\b(?:99\.9%|99\.99%) monthly availability\b/iu,
  },
];

const requiredAdrSections = [
  "## Context",
  "## Decision",
  "## Alternatives considered",
  "## Consequences",
  "## Reversal triggers",
];

export async function verifyLaunchDocumentation(workspaceRoot = defaultWorkspaceRoot) {
  const errors = [];
  const sources = new Map();
  const documentPaths = [
    ...new Set([
      ...launchDocumentPaths,
      scopeDocumentPath,
      ...scopeConsumerPaths,
      "docs/final-release-supporting-evidence.md",
      "docs/adr/README.md",
      ...adrPaths,
    ]),
  ];

  for (const documentPath of documentPaths) {
    try {
      sources.set(documentPath, await readFile(join(workspaceRoot, documentPath), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(`${documentPath}: required document is missing`);
        continue;
      }
      throw error;
    }
  }

  for (const documentPath of launchDocumentPaths) {
    const source = sources.get(documentPath);
    if (source === undefined) {
      continue;
    }
    errors.push(...findClaimErrors(documentPath, source));
  }

  const scope = sources.get(scopeDocumentPath);
  if (scope !== undefined) {
    for (const documentPath of [scopeDocumentPath, ...scopeConsumerPaths]) {
      const source = sources.get(documentPath);
      if (source !== undefined) errors.push(...findScopeErrors(documentPath, source, scope));
    }
  }
  for (const [documentPath, source] of sources) {
    if (
      /HELIX_RELEASE_\w*EDITORS|"editorsSha"|paired-source\/v1|editors\.(?:revision|changed)/u.test(
        source,
      )
    ) {
      errors.push(`${documentPath}: obsolete sibling release binding`);
    }
  }

  const indexSource = sources.get("docs/adr/README.md");
  for (const [index, adrPath] of adrPaths.entries()) {
    const source = sources.get(adrPath);
    if (source !== undefined) {
      errors.push(...findAdrErrors(adrPath, source, index + 1));
    }
    if (indexSource !== undefined && !indexSource.includes(`(${relative("docs/adr", adrPath)})`)) {
      errors.push(`docs/adr/README.md: missing link to ${adrPath}`);
    }
  }

  errors.push(...(await findBrokenLocalLinks(workspaceRoot, sources)));
  return errors;
}

export function findScopeErrors(documentPath, source, scope) {
  const errors = [];
  const claims = [
    ["shipped surfaces", /Mail, Drive, Chat, Assistant, and Admin/u],
    ["invite-only access", /invite-only/iu],
    [
      "dormant Calendar and Meet",
      /Calendar and Meet are dormant behind the `full` profile and are outside 1\.0/u,
    ],
    ["exact production apps", /`HELIX_APPS=mail,drive,chat,assistant`/u],
    ["MVP web packaging", /`VITE_HELIX_MVP_ONLY=true`/u],
  ];
  for (const [id, pattern] of claims) {
    if (!pattern.test(scope) || !pattern.test(source))
      errors.push(`${documentPath}: scope mismatch: ${id}`);
  }
  if (documentPath !== scopeDocumentPath && !source.includes("1.0-scope.md)")) {
    errors.push(`${documentPath}: missing canonical scope link`);
  }
  const appValues = [...source.matchAll(/HELIX_APPS=([^`\s]+)/gu)];
  if (appValues.some((match) => match[1] !== "mail,drive,chat,assistant")) {
    errors.push(`${documentPath}: production app list differs from canonical scope`);
  }
  if (/read-only previews|HELIX_RELEASE_\w*EDITORS|"editorsSha"/iu.test(source)) {
    errors.push(`${documentPath}: removed capability or sibling release requirement`);
  }
  return errors;
}

export function findClaimErrors(documentPath, source) {
  const errors = [];
  for (const claim of requiredClaimPatterns) {
    if (!claim.pattern.test(source)) {
      errors.push(`${documentPath}: missing required claim: ${claim.id}`);
    }
  }
  for (const claim of prohibitedClaimPatterns) {
    if (claim.pattern.test(source)) {
      errors.push(`${documentPath}: prohibited unqualified claim: ${claim.id}`);
    }
  }
  return errors;
}

export function findAdrErrors(documentPath, source, decisionNumber) {
  const errors = [];
  if (!source.includes("- **Status:** Accepted")) {
    errors.push(`${documentPath}: ADR status must be Accepted`);
  }
  if (!source.includes("- **Date:** 2026-07-28")) {
    errors.push(`${documentPath}: ADR date must record the owner decision date`);
  }
  if (!source.includes(`- **Plan decision:** RD-${decisionNumber}`)) {
    errors.push(`${documentPath}: ADR must map to RD-${decisionNumber}`);
  }
  for (const section of requiredAdrSections) {
    if (!source.includes(section)) {
      errors.push(`${documentPath}: missing ADR section: ${section}`);
    }
  }
  return errors;
}

export async function findBrokenLocalLinks(workspaceRoot, sources) {
  const errors = [];
  const markdownLinkPattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;

  for (const [documentPath, source] of sources) {
    for (const match of source.matchAll(markdownLinkPattern)) {
      const rawTarget = match[1];
      if (
        rawTarget === undefined ||
        rawTarget.startsWith("#") ||
        /^(?:https?:|mailto:|tel:)/iu.test(rawTarget)
      ) {
        continue;
      }

      const targetWithoutAnchor = rawTarget.replace(/^<|>$/gu, "").split("#", 1)[0];
      if (targetWithoutAnchor === "") {
        continue;
      }

      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(targetWithoutAnchor);
      } catch {
        errors.push(`${documentPath}: malformed link target: ${rawTarget}`);
        continue;
      }

      const absoluteTarget = isAbsolute(decodedTarget)
        ? join(workspaceRoot, decodedTarget)
        : resolve(workspaceRoot, dirname(documentPath), decodedTarget);
      try {
        await access(absoluteTarget);
      } catch (error) {
        if (error?.code === "ENOENT") {
          errors.push(`${documentPath}: broken local link: ${rawTarget}`);
          continue;
        }
        throw error;
      }
    }
  }

  return errors;
}

async function main() {
  const errors = await verifyLaunchDocumentation();
  if (errors.length === 0) {
    console.log(
      `Launch documentation verified: ${launchDocumentPaths.length} claim documents, ${adrPaths.length} ADRs, and local links are consistent.`,
    );
    return;
  }

  console.error("Launch documentation fidelity violations found:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  await main();
}
