import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ChronologyLedger } from "./chronology.js";
import { assertLocalSeedTarget, parseDemoSeedArgs } from "./cli.js";
import { activePeople, buildRoster, LOGIN_ACCOUNTS } from "./company.js";
import { avatarPng, csv, simplePdf } from "./files.js";
import { DEMO_PRESETS } from "./presets.js";
import { DemoTimeline, SeedRandom, seedUuid } from "./random.js";

describe("demo seed arguments", () => {
  const now = new Date("2026-10-01T15:42:31.250Z");

  it("defaults to the medium preset anchored to the current minute", () => {
    expect(parseDemoSeedArgs([], now)).toEqual({
      size: "medium",
      reset: false,
      accountsOnly: false,
      now: new Date("2026-10-01T15:42:00.000Z"),
    });
  });

  it("accepts every option, including after pnpm's -- separator", () => {
    expect(parseDemoSeedArgs(["--", "--size", "small", "--reset", "--accounts-only"], now)).toEqual(
      {
        size: "small",
        reset: true,
        accountsOnly: true,
        now: new Date("2026-10-01T15:42:00.000Z"),
      },
    );
  });

  it("rejects unknown sizes, missing values and unknown options", () => {
    expect(() => parseDemoSeedArgs(["--size", "huge"], now)).toThrow(/--size must be one of/u);
    expect(() => parseDemoSeedArgs(["--size", "--reset"], now)).toThrow(/needs a value/u);
    expect(() => parseDemoSeedArgs(["--now", "2026-01-01T00:00:00Z"], now)).toThrow(
      /Unknown option/u,
    );
  });

  it("only targets loopback services", () => {
    expect(() => {
      assertLocalSeedTarget(["postgres://helix@127.0.0.1:5432/helix", undefined]);
    }).not.toThrow();
    expect(() => {
      assertLocalSeedTarget(["postgres://helix@db.internal:5432/helix"]);
    }).toThrow(/loopback/u);
  });
});

describe("demo seed determinism", () => {
  it("draws the same sequence for the same stream and a different one otherwise", () => {
    const first = SeedRandom.stream("mail", "person-1");
    const again = SeedRandom.stream("mail", "person-1");
    const other = SeedRandom.stream("mail", "person-2");
    const draw = (random: SeedRandom) => Array.from({ length: 5 }, () => random.int(0, 1_000_000));
    expect(draw(first)).toEqual(draw(again));
    expect(draw(SeedRandom.stream("mail", "person-1"))).not.toEqual(draw(other));
  });

  it("derives stable version-4 shaped ids", () => {
    expect(seedUuid("service-account", "deploy-bot")).toBe(
      seedUuid("service-account", "deploy-bot"),
    );
    expect(seedUuid("service-account", "deploy-bot")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("builds rosters where a smaller preset is a prefix of a larger one", () => {
    const small = buildRoster(DEMO_PRESETS.small.headcount);
    const large = buildRoster(DEMO_PRESETS.large.headcount);
    expect(large.slice(0, small.length).map((person) => person.email)).toEqual(
      small.map((person) => person.email),
    );
    expect(new Set(large.map((person) => person.email)).size).toBe(large.length);
    for (const login of LOGIN_ACCOUNTS) {
      expect(small.find((person) => person.email === login.email)).toMatchObject({
        actorId: login.actorId,
        password: login.password,
        status: "active",
      });
    }
    expect(activePeople(small).length).toBeLessThan(small.length);
  });

  it("never dates generated history in the future", () => {
    const now = new Date("2026-10-01T15:00:00.000Z");
    const timeline = new DemoTimeline(now, 800);
    const random = SeedRandom.stream("timeline");
    for (let index = 0; index < 200; index += 1) {
      const when = timeline.recentWorkday(random, 30);
      expect(when.getTime()).toBeLessThan(now.getTime());
      expect(when.getTime()).toBeGreaterThan(now.getTime() - 32 * 86_400_000);
    }
  });
});

describe("demo seed files", () => {
  it("encodes real PNG, PDF and CSV bytes", () => {
    const png = avatarPng("person-3");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const idat = png.indexOf("IDAT");
    const length = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + length)).length).toBeGreaterThan(0);
    expect(avatarPng("person-3").equals(png)).toBe(true);

    const pdf = simplePdf("Quarterly review", ["Revenue up", "Churn down"]).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);

    expect(
      csv([
        ["name", "note"],
        ["Ada", 'said "hi", left'],
      ]).toString("utf8"),
    ).toBe('name,note\nAda,"said ""hi"", left"\n');
  });
});

describe("demo seed chronology", () => {
  it("only rewrites the timestamp columns it manages, latest record winning", () => {
    const ledger = new ChronologyLedger();
    ledger.at("objects", { id: "a" }, { created_at: new Date(1) });
    ledger.at("objects", { id: "a" }, { created_at: new Date(2) });
    expect(ledger.size).toBe(1);
    expect(() => {
      ledger.at("drive_versions", { id: "a" }, { created_at: new Date(1) });
    }).toThrow(/does not manage table/u);
    expect(() => {
      ledger.at("objects", { id: "a" }, { byte_size: new Date(1) });
    }).toThrow(/does not manage objects.byte_size/u);
  });
});
