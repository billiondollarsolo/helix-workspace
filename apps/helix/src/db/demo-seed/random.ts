import { createHash } from "node:crypto";

/**
 * Deterministic randomness for the demo seed. Every generator is derived from a
 * named stream, so adding content to one area never reshuffles another area.
 */
export class SeedRandom {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string) {
    const digest = createHash("sha256").update(seed).digest();
    this.#a = digest.readUInt32LE(0);
    this.#b = digest.readUInt32LE(4);
    this.#c = digest.readUInt32LE(8);
    this.#d = digest.readUInt32LE(12) | 1;
  }

  /** A child stream that is independent of how much this stream was consumed. */
  static stream(...parts: readonly (string | number)[]): SeedRandom {
    return new SeedRandom(`helix-demo-seed:${parts.join(":")}`);
  }

  /** sfc32: fast, small-state and well distributed for fixture generation. */
  next(): number {
    this.#a >>>= 0;
    this.#b >>>= 0;
    this.#c >>>= 0;
    this.#d >>>= 0;
    let t = (this.#a + this.#b) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#d = (this.#d + 1) | 0;
    t = (t + this.#d) | 0;
    this.#c = (this.#c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("Cannot pick from an empty list.");
    return values[Math.floor(this.next() * values.length)] as T;
  }

  /** Picks `count` distinct values, preserving no particular order. */
  sample<T>(values: readonly T[], count: number): T[] {
    const pool = [...values];
    const result: T[] = [];
    while (result.length < count && pool.length > 0) {
      const index = Math.floor(this.next() * pool.length);
      result.push(pool.splice(index, 1)[0] as T);
    }
    return result;
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return (entries.at(-1) as readonly [T, number])[0];
  }

  shuffle<T>(values: readonly T[]): T[] {
    return this.sample(values, values.length);
  }
}

/**
 * A stable UUID (version 4 layout, variant 1) for a seed key. Re-running the
 * seed resolves the same identifiers, which keeps every phase idempotent.
 */
export function seedUuid(...parts: readonly (string | number)[]): string {
  const hex = createHash("sha256")
    .update(`helix-demo-seed-id:${parts.join(":")}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Wall-clock helpers anchored to the run's "now". The demo company has used
 * Helix for `historyDays`; activity clusters on weekdays inside office hours.
 */
export class DemoTimeline {
  readonly start: Date;

  constructor(
    readonly now: Date,
    readonly historyDays: number,
  ) {
    this.start = new Date(now.getTime() - historyDays * DAY);
  }

  daysAgo(days: number, hour = 9, minute = 0): Date {
    const day = new Date(this.now.getTime() - days * DAY);
    day.setUTCHours(hour, minute, 0, 0);
    return day;
  }

  /** A working-hours instant `daysAgo` days back, nudged off weekends. */
  workday(random: SeedRandom, daysAgo: number): Date {
    let day = new Date(this.now.getTime() - daysAgo * DAY);
    while (isWeekend(day)) day = new Date(day.getTime() - DAY);
    const hour = random.weighted<number>([
      [13, 6],
      [14, 9],
      [15, 10],
      [16, 9],
      [17, 6],
      [18, 8],
      [19, 9],
      [20, 8],
      [21, 5],
      [22, 2],
      [23, 1],
    ]);
    day.setUTCHours(hour, random.int(0, 59), random.int(0, 59), random.int(0, 999));
    return this.clamp(day);
  }

  /**
   * A working-hours instant somewhere in the history, biased toward the recent
   * past the way a growing company's mailbox is.
   */
  recentWorkday(random: SeedRandom, maxDaysAgo = this.historyDays): Date {
    const skew = random.next() ** 1.8;
    return this.workday(random, Math.max(0, Math.floor(skew * maxDaysAgo)));
  }

  /** An occasional off-hours instant: evenings, early mornings and weekends. */
  offHours(random: SeedRandom, maxDaysAgo = this.historyDays): Date {
    const day = new Date(this.now.getTime() - random.int(0, maxDaysAgo) * DAY);
    day.setUTCHours(random.pick([1, 2, 3, 4, 10, 11, 12]), random.int(0, 59), random.int(0, 59));
    return this.clamp(day);
  }

  after(base: Date, random: SeedRandom, minMinutes: number, maxMinutes: number): Date {
    return this.clamp(new Date(base.getTime() + random.int(minMinutes, maxMinutes) * MINUTE));
  }

  /** Never in the future: generated history stops a minute before "now". */
  clamp(value: Date): Date {
    const latest = this.now.getTime() - MINUTE;
    return value.getTime() > latest ? new Date(latest) : value;
  }

  /** Midnight UTC of the week's Monday containing "now". */
  weekStart(): Date {
    const monday = new Date(this.now);
    monday.setUTCHours(0, 0, 0, 0);
    const offset = (monday.getUTCDay() + 6) % 7;
    return new Date(monday.getTime() - offset * DAY);
  }
}

function isWeekend(value: Date): boolean {
  const day = value.getUTCDay();
  return day === 0 || day === 6;
}

export const TIME = { MINUTE, HOUR, DAY } as const;
