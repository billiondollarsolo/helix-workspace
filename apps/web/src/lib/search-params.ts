const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

export function optionalStringSearchParam(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function stringSearchParam(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optionalRawStringSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalUuidSearchParam(value: unknown): string | undefined {
  const candidate = optionalStringSearchParam(value);
  return candidate !== undefined && uuidPattern.test(candidate) ? candidate : undefined;
}

export function optionalBooleanSearchParam(value: unknown): true | undefined {
  return value === true || value === "true" || value === "1" ? true : undefined;
}

export function optionalEnumSearchParam<const TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
): TValue | undefined {
  return typeof value === "string" && allowedValues.includes(value as TValue)
    ? (value as TValue)
    : undefined;
}

export function optionalIsoDateSearchParam(value: unknown): string | undefined {
  const candidate = optionalStringSearchParam(value);
  if (candidate === undefined || !isoDatePattern.test(candidate)) {
    return undefined;
  }
  const [year = "0", month = "1", day = "1"] = candidate.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate
    ? undefined
    : candidate;
}
