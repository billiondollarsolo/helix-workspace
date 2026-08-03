import { describe, expect, it } from "vitest";
import {
  evaluateMinCounts,
  MIN_COUNTS,
  parseArgs,
  parseSeedJson,
} from "./local-volume-soak.mjs";

describe("local-volume-soak", () => {
  it("parses write-wave and org-id", () => {
    const opts = parseArgs([
      "--",
      "--base-url",
      "http://127.0.0.1:38600",
      "--write-wave",
      "500",
      "--org-id",
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(opts.baseUrl).toBe("http://127.0.0.1:38600");
    expect(opts.writeWave).toBe(500);
    expect(opts.orgId).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("requires multi-user and multi-surface volume mins", () => {
    expect(MIN_COUNTS.actors).toBeGreaterThanOrEqual(20);
    expect(MIN_COUNTS.chatMessages).toBeGreaterThanOrEqual(2000);
    expect(MIN_COUNTS.mailThreads).toBeGreaterThanOrEqual(200);
    expect(MIN_COUNTS.driveObjects).toBeGreaterThanOrEqual(50);

    const fail = evaluateMinCounts({
      actors: 5,
      mailThreads: 10,
      mailMessages: 10,
      chatRooms: 1,
      chatMessages: 50,
      driveObjects: 2,
    });
    expect(fail.ok).toBe(false);
    expect(fail.failures.length).toBeGreaterThan(0);

    const pass = evaluateMinCounts({
      actors: 26,
      mailThreads: 272,
      mailMessages: 322,
      chatRooms: 40,
      chatMessages: 3870,
      driveObjects: 262,
    });
    expect(pass.ok).toBe(true);
  });

  it("parses pretty-printed seed JSON from CLI stdout", () => {
    const pretty = `seeding…
{
  "orgId": "00000000-0000-0000-0000-000000000000",
  "durationMs": 12000,
  "counts": {
    "teammates": 23,
    "mailThreads": 270,
    "chatRooms": 30,
    "chatMessages": 4670,
    "driveFiles": 130
  }
}
`;
    const parsed = parseSeedJson(pretty);
    expect(parsed.counts.teammates).toBe(23);
    expect(parsed.counts.chatMessages).toBe(4670);
    expect(parseSeedJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseSeedJson("")).toBeNull();
  });
});
