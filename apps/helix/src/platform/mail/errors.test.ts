import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../api/api-error.js";
import {
  MailFilterNotFoundError,
  MailInboundActorForbiddenError,
  MailThreadNotFoundError,
} from "./errors.js";

describe("mail errors", () => {
  it("MailThreadNotFoundError is a 404 ApiError carrying the thread id", () => {
    const e = new MailThreadNotFoundError("t1");
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe("not_found");
    expect(String(e.message)).toContain("t1");
  });

  it("MailFilterNotFoundError is a 404", () => {
    expect(new MailFilterNotFoundError("f1").statusCode).toBe(404);
  });

  it("MailInboundActorForbiddenError is a 403", () => {
    const e = new MailInboundActorForbiddenError("user");
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e.statusCode).toBe(403);
  });
});
