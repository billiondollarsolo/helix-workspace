/* Calendar colours come from the shared `--label-*` palette, which keeps
   readable text on every fill in light and dark themes. A calendar stores a
   free-form colour; it is shown as the nearest palette entry by hue. */

/** Palette names with their OKLCH hue, as defined in styles.css. */
const LABEL_HUES = {
  red: 25,
  coral: 38,
  orange: 55,
  amber: 75,
  yellow: 95,
  olive: 110,
  lime: 130,
  green: 150,
  emerald: 165,
  mint: 178,
  teal: 190,
  cyan: 210,
  sky: 230,
  blue: 255,
  indigo: 275,
  violet: 295,
  purple: 310,
  plum: 325,
  fuchsia: 335,
  pink: 350,
  rose: 10,
} as const;

type HuedLabel = keyof typeof LABEL_HUES;
export type CalendarLabel = HuedLabel | "brown" | "slate" | "gray";

export const DEFAULT_CALENDAR_LABEL: CalendarLabel = "blue";

function isLabel(value: string): value is CalendarLabel {
  return value in LABEL_HUES || value === "brown" || value === "slate" || value === "gray";
}

/** sRGB channel (0-1) → linear light. */
function linear(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** OKLCH chroma and hue (degrees) of a `#rrggbb` colour. */
function oklchOf(hex: string): { readonly chroma: number; readonly hue: number } | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
  if (match === null) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
    linear(Number.parseInt(part ?? "0", 16) / 255),
  ) as [number, number, number];
  const l = Math.cbrt(0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b);
  const m = Math.cbrt(0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b);
  const s = Math.cbrt(0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b);
  const a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
  const bAxis = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
  const hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
  return { chroma: Math.hypot(a, bAxis), hue: (hue + 360) % 360 };
}

function hueDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** The palette entry for a stored calendar colour (a palette name or `#rrggbb`). */
export function calendarLabel(color: string | null | undefined): CalendarLabel {
  const value = (color ?? "").trim().toLowerCase();
  if (isLabel(value)) return value;
  const oklch = oklchOf(value);
  if (oklch === null) return DEFAULT_CALENDAR_LABEL;
  if (oklch.chroma < 0.05) return "slate";
  let best: HuedLabel = DEFAULT_CALENDAR_LABEL as HuedLabel;
  for (const [name, hue] of Object.entries(LABEL_HUES) as [HuedLabel, number][]) {
    if (hueDistance(oklch.hue, hue) < hueDistance(oklch.hue, LABEL_HUES[best])) best = name;
  }
  return best;
}

/** Solid fill for event chips and swatches; pair with `var(--label-on)` text. */
export function labelFill(label: CalendarLabel): string {
  return `var(--label-${label})`;
}

/** Tinted fill for invitations not yet accepted; pair with `var(--text)`. */
export function labelSoftFill(label: CalendarLabel): string {
  return `var(--label-${label}-soft)`;
}
