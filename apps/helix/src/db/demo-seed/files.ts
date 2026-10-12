import { deflateSync } from "node:zlib";
import { SeedRandom } from "./random.js";

/** Small, valid binary documents generated in code: no fixtures, no network. */

type Rgb = readonly [number, number, number];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A truecolor PNG from a pixel callback. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const AVATAR_PALETTE: readonly (readonly [Rgb, Rgb])[] = [
  [
    [32, 87, 129],
    [222, 236, 247],
  ],
  [
    [124, 58, 93],
    [247, 228, 238],
  ],
  [
    [46, 112, 80],
    [226, 243, 233],
  ],
  [
    [158, 92, 28],
    [251, 237, 222],
  ],
  [
    [83, 74, 160],
    [234, 232, 250],
  ],
  [
    [20, 110, 120],
    [222, 243, 245],
  ],
  [
    [150, 52, 52],
    [249, 228, 226],
  ],
];

/**
 * A symmetric 5x5 identicon on a soft background, 96px square: recognisable
 * per person, clearly abstract, and stable for a given key.
 */
export function avatarPng(key: string): Buffer {
  const random = SeedRandom.stream("avatar", key);
  const [ink, paper] = random.pick(AVATAR_PALETTE);
  const cells = Array.from({ length: 5 }, () =>
    Array.from({ length: 3 }, () => random.chance(0.5)),
  );
  const size = 96;
  const cell = 14;
  const margin = (size - cell * 5) / 2;
  return encodePng(size, size, (x, y) => {
    const column = Math.floor((x - margin) / cell);
    const row = Math.floor((y - margin) / cell);
    if (column < 0 || column > 4 || row < 0 || row > 4) return paper;
    const mirrored = column > 2 ? 4 - column : column;
    return cells[row]?.[mirrored] === true ? ink : paper;
  });
}

export function pngDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A simple bar chart PNG (no text) for report attachments. */
export function barChartPng(values: readonly number[], key: string): Buffer {
  const random = SeedRandom.stream("chart", key);
  const width = 480;
  const height = 270;
  const max = Math.max(...values, 1);
  const barWidth = Math.floor((width - 60) / Math.max(values.length, 1));
  const color = random.pick<Rgb>([
    [37, 99, 235],
    [5, 150, 105],
    [217, 119, 6],
    [124, 58, 237],
  ]);
  return encodePng(width, height, (x, y) => {
    if (y === height - 30 || x === 40) return [90, 90, 90];
    if (y % 48 === 0 && x > 40) return [228, 228, 228];
    const index = Math.floor((x - 44) / barWidth);
    if (x > 44 && index < values.length && (x - 44) % barWidth < barWidth - 8) {
      const barHeight = ((values[index] ?? 0) / max) * (height - 60);
      if (y < height - 30 && y > height - 30 - barHeight) return color;
    }
    return [255, 255, 255];
  });
}

function pdfEscape(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^\x20-\x7e]/gu, "-")
    .replace(/([\\()])/gu, "\\$1");
}

/**
 * A one-page PDF 1.4 document with a title and wrapped body lines, using the
 * standard Helvetica font so it needs no embedded resources.
 */
export function simplePdf(title: string, lines: readonly string[]): Buffer {
  const wrapped = lines.flatMap((line) => wrapLine(line, 88));
  const text = [
    "BT",
    "/F1 18 Tf",
    "56 780 Td",
    `(${pdfEscape(title)}) Tj`,
    "/F1 10.5 Tf",
    "0 -30 Td",
    "14 TL",
    ...wrapped.slice(0, 48).map((line) => `(${pdfEscape(line)}) '`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${String(Buffer.byteLength(text, "latin1"))} >>\nstream\n${text}\nendstream`,
    `<< /Title (${pdfEscape(title)}) /Producer (Quillfeather internal tools) >>`,
  ];
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const words = line.split(" ");
  const result: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      result.push(current);
      current = word;
    } else current = current.length === 0 ? word : `${current} ${word}`;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function csv(rows: readonly (readonly (string | number)[])[]): Buffer {
  return Buffer.from(
    `${rows
      .map((row) =>
        row
          .map((cell) => {
            const value = String(cell);
            return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
          })
          .join(","),
      )
      .join("\n")}\n`,
  );
}

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
