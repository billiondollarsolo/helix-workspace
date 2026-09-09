import { createHash } from "node:crypto";

import {
  HASH_PATTERN,
  OWNER_PATTERN,
  SECRET_VALUE_PATTERN,
  SENSITIVE_FIELD_PATTERN,
} from "./constants.mjs";

export function registerArtifactIdentity(reference, label, context) {
  const prior = context.artifactPaths.get(reference.path);
  if (prior !== undefined) {
    throw new Error(`${label} reuses the artifact already assigned to ${prior}`);
  }
  const priorDigest = context.artifactDigests.get(reference.sha256);
  if (priorDigest !== undefined) {
    throw new Error(`${label} reuses byte-identical retained artifact assigned to ${priorDigest}`);
  }
  context.artifactPaths.set(reference.path, label);
  context.artifactDigests.set(reference.sha256, label);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceSetDigest(entries) {
  const normalized = entries
    .map(({ path, sha256 }) => {
      nonEmptyString(path, "evidence path");
      hash(sha256, `evidence ${path} sha256`);
      return `${path}:${sha256}`;
    })
    .sort();
  if (new Set(normalized).size !== normalized.length || normalized.length === 0) {
    throw new Error("decision evidence set must contain unique evidence paths");
  }
  return `sha256:${createHash("sha256").update(normalized.join("\n")).digest("hex")}`;
}

export function exactObject(value, keys, label) {
  object(value, label);
  exactKeys(value, keys);
}

export function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameOrderedStrings(actual, expected)) {
    throw new Error("evidence contains unexpected or missing fields");
  }
}

export function exactStringSet(value, expectedValues, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const actual = [...value].sort();
  const expected = [...expectedValues].sort();
  if (new Set(actual).size !== actual.length || !sameOrderedStrings(actual, expected)) {
    throw new Error(`${label} does not match the approved MVP boundary`);
  }
}

function sameOrderedStrings(actual, expected) {
  return (
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
  );
}

export function rejectSensitiveContent(value, label) {
  if (Array.isArray(value)) {
    for (const entry of value) rejectSensitiveContent(entry, label);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_FIELD_PATTERN.test(key))
        throw new Error(`${label} contains a secret-like field`);
      rejectSensitiveContent(entry, label);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
    throw new Error(`${label} contains secret-like content`);
  }
}

export function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
}

export function owner(value, label) {
  if (typeof value !== "string" || !OWNER_PATTERN.test(value)) {
    throw new Error(`${label} must identify an accountable owner`);
  }
}

export function hash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
}

export function isoDate(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO-8601 timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return date;
}

export function futureDate(value, referenceTime, label) {
  const date = isoDate(value, label);
  if (date.getTime() <= referenceTime.getTime()) throw new Error(`${label} is expired`);
}

export function orderedWindow(startedAt, completedAt, label) {
  const started = isoDate(startedAt, `${label} startedAt`);
  const completed = isoDate(completedAt, `${label} completedAt`);
  const duration = completed.getTime() - started.getTime();
  if (duration < 0) throw new Error(`${label} completes before it starts`);
  return duration;
}

export function notAfter(value, upperBound, label) {
  if (isoDate(value, label).getTime() > isoDate(upperBound, `${label} upper bound`).getTime()) {
    throw new Error(`${label} occurs after its evidence was generated`);
  }
}

export function freshTimestamp(value, referenceTime, maximumAgeMs, label) {
  const date = isoDate(value, label);
  const age = referenceTime.getTime() - date.getTime();
  if (age < 0) throw new Error(`${label} is in the future`);
  if (age > maximumAgeMs) throw new Error(`${label} is stale for final release`);
}

export function passed(value, label) {
  if (value !== "passed") throw new Error(`${label} must be passed`);
}

export function truth(value, label) {
  if (value !== true) throw new Error(`${label} must be confirmed`);
}

export function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

export function nonNegativeFinite(value, label) {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative`);
}

export function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
}
