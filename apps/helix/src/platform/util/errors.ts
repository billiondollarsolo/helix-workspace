export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeErrorMessage(error: unknown): string {
  return errorMessage(error)
    .replaceAll(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}
