export function envValueFlag(value: string, defaultValue: boolean): boolean {
  if (value.length === 0) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function trimmedEnvFlag(value: string | undefined, defaultValue = false): boolean {
  return value === undefined ? defaultValue : envValueFlag(value.trim(), defaultValue);
}
