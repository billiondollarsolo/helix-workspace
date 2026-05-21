import { describe, expect, it } from "vitest";
import { parsePrepareLocalDemoArgs } from "./prepare-local-demo.js";

describe("parsePrepareLocalDemoArgs", () => {
  it("defaults to migrate, seed, reindex, and verify", () => {
    expect(parsePrepareLocalDemoArgs([])).toEqual({
      migrate: true,
      reindex: true,
      verify: true,
      requireStorage: false,
      requireSearch: false,
      volumeSearch: false,
      volumeMailMessages: 10_000,
    });
  });

  it("parses strict local service and batching options", () => {
    expect(
      parsePrepareLocalDemoArgs([
        "--",
        "--skip-migrate",
        "--skip-reindex",
        "--skip-verify",
        "--require-storage",
        "--require-search",
        "--batch-size",
        "3",
      ]),
    ).toEqual({
      migrate: false,
      reindex: false,
      verify: false,
      requireStorage: true,
      requireSearch: true,
      batchSize: 3,
      volumeSearch: false,
      volumeMailMessages: 10_000,
    });
  });

  it("parses volume search options", () => {
    expect(parsePrepareLocalDemoArgs(["--volume-search", "--volume-mail-count", "250"])).toEqual({
      migrate: true,
      reindex: true,
      verify: true,
      requireStorage: false,
      requireSearch: false,
      volumeSearch: true,
      volumeMailMessages: 250,
    });
  });

  it("parses anchor date options", () => {
    expect(parsePrepareLocalDemoArgs(["--anchor-date", "2026-05-21"])).toEqual({
      migrate: true,
      reindex: true,
      verify: true,
      requireStorage: false,
      requireSearch: false,
      volumeSearch: false,
      volumeMailMessages: 10_000,
      anchorDate: "2026-05-21",
    });
  });

  it("rejects invalid batch sizes", () => {
    expect(() => parsePrepareLocalDemoArgs(["--batch-size", "0"])).toThrow(
      "--batch-size requires a positive integer",
    );
  });

  it("rejects invalid volume counts", () => {
    expect(() => parsePrepareLocalDemoArgs(["--volume-mail-count", "0"])).toThrow(
      "--volume-mail-count requires a positive integer",
    );
  });

  it("rejects invalid anchor dates", () => {
    expect(() => parsePrepareLocalDemoArgs(["--anchor-date", "2026-02-31"])).toThrow(
      "--anchor-date requires a valid calendar date",
    );
    expect(() => parsePrepareLocalDemoArgs(["--anchor-date", "05/21/2026"])).toThrow(
      "--anchor-date requires YYYY-MM-DD",
    );
  });

  it("rejects unknown options", () => {
    expect(() => parsePrepareLocalDemoArgs(["--unknown"])).toThrow("Unknown option: --unknown");
  });
});
