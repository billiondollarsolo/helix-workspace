import type {
  ClassificationDerivation,
  ClassificationDerivationInput,
  ClassificationHeuristicRule,
  ClassificationPolicy,
  DataClassification,
} from "./types.js";

const classificationRank: Record<DataClassification, number> = {
  public: 0,
  standard: 1,
  confidential: 2,
  restricted: 3,
};

const defaultLabelMappings = new Map<string, DataClassification>([
  ["public", "public"],
  ["confidential", "confidential"],
  ["restricted", "restricted"],
  ["hr", "confidential"],
  ["legal", "confidential"],
]);

const defaultFolderMappings = new Map<string, DataClassification>([
  ["/public/", "public"],
  ["/confidential/", "confidential"],
  ["/hr/", "confidential"],
  ["/legal/", "confidential"],
  ["/restricted/", "restricted"],
]);

const defaultHeuristicRules: readonly ClassificationHeuristicRule[] = [
  {
    id: "us-ssn",
    classification: "confidential",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    id: "payment-card",
    classification: "confidential",
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
  },
  {
    id: "restricted-marker",
    classification: "restricted",
    pattern: /\b(?:restricted|air[- ]?gapped|export controlled)\b/i,
  },
];

export const defaultClassificationPolicy: ClassificationPolicy = {
  defaultClassification: "standard",
  labelMappings: defaultLabelMappings,
  folderMappings: defaultFolderMappings,
  heuristicRules: defaultHeuristicRules,
};

export function deriveClassification(
  input: ClassificationDerivationInput,
  policy: ClassificationPolicy = defaultClassificationPolicy,
): ClassificationDerivation {
  const candidates: ClassificationDerivation[] = [
    {
      classification: policy.defaultClassification,
      source: "default",
      reason: "policy default",
    },
  ];

  if (input.explicit !== undefined) {
    candidates.push({
      classification: input.explicit,
      source: "explicit",
      reason: "explicit classification",
    });
  }

  for (const label of input.labels ?? []) {
    const classification = policy.labelMappings.get(normalizeLabel(label));
    if (classification !== undefined) {
      candidates.push({
        classification,
        source: "label",
        reason: `label:${label}`,
      });
    }
  }

  const normalizedPath = normalizePath(input.path);
  if (normalizedPath !== undefined) {
    for (const [prefix, classification] of policy.folderMappings) {
      if (normalizedPath.includes(prefix)) {
        candidates.push({
          classification,
          source: "folder",
          reason: `folder:${prefix}`,
        });
      }
    }
  }

  if (input.scanContent === true && input.content !== undefined) {
    for (const rule of policy.heuristicRules) {
      if (rule.pattern.test(input.content)) {
        candidates.push({
          classification: rule.classification,
          source: "heuristic",
          reason: `heuristic:${rule.id}`,
        });
      }
    }
  }

  return candidates.reduce(maxDerivation);
}

export function maxClassification(left: DataClassification, right: DataClassification): DataClassification {
  return classificationRank[left] >= classificationRank[right] ? left : right;
}

export function compareClassifications(left: DataClassification, right: DataClassification): number {
  return classificationRank[left] - classificationRank[right];
}

function maxDerivation(left: ClassificationDerivation, right: ClassificationDerivation): ClassificationDerivation {
  return compareClassifications(left.classification, right.classification) >= 0 ? left : right;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined || path.trim() === "") {
    return undefined;
  }

  const withSlashes = path.startsWith("/") ? path : `/${path}`;
  return withSlashes.endsWith("/") ? withSlashes.toLowerCase() : `${withSlashes.toLowerCase()}/`;
}
