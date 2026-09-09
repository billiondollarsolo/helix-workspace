import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import { ChatMessageNotFoundError, ChatRateLimitedError, ChatRoomAccessError } from "./errors.js";

describe("chat errors", () => {
  it("ChatRoomAccessError is a non-enumerable ApiError", () => {
    const e = new ChatRoomAccessError("11111111-1111-4111-8111-111111111111");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.statusCode).toBe(404);
    expect(e.message).not.toContain("11111111");
    expect(e.details).toBeUndefined();
    expect(e.roomId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("ChatMessageNotFoundError is ApiError not_found", () => {
    const e = new ChatMessageNotFoundError("22222222-2222-4222-8222-222222222222");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.messageId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("ChatRateLimitedError is ApiError rate_limited", () => {
    const e = new ChatRateLimitedError();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("rate_limited");
  });
});
