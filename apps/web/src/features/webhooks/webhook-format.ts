import { toast } from "sonner";
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRotateOutput(value: unknown): value is { readonly secretRef: string } {
  return isRecord(value) && typeof value.secretRef === "string";
}

export function showError(error: Error) {
  toast.error(error.message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDate(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast.success("Copied");
}
