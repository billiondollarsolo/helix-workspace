import type { ZodType } from "zod";
import type { ErrorCode } from "./errors.js";

export interface ContractIssue {
  path: (string | number)[];
  message: string;
}

export class ContractValidationError extends Error {
  readonly code: ErrorCode = "bad_request";
  readonly statusCode = 400;
  readonly issues: ContractIssue[];
  constructor(issues: ContractIssue[]) {
    super(`Request validation failed: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ContractValidationError(
    result.error.issues.map((issue) => ({ path: [...issue.path], message: issue.message })),
  );
}
