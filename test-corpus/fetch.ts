#!/usr/bin/env tsx
/* Helix test corpus — fetch.
 *
 * Reads ./manifest.json and downloads each source into ./<targetDir>/.
 * Idempotent: skips files already present unless --force is passed.
 *
 * Run from repo root:    pnpm corpus:fetch
 * Or directly:           tsx test-corpus/fetch.ts
 *
 * Uses execFile (no shell) for all subprocess calls — the URLs come from the
 * checked-in manifest.json, not user input, but we keep execFile to satisfy
 * project security policy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes("--force");
const ONLY = process.argv
  .filter((arg) => arg.startsWith("--only="))
  .flatMap((arg) => arg.slice("--only=".length).split(","));

interface ManifestSource {
  id: string;
  label: string;
  license: string;
  homepage: string;
  targetDir: string;
  expectedFileCountMin?: number;
  optional?: boolean;
  strategy:
    | "github-tarball-subdir"
    | "commonmark-spec-split"
    | "picsum"
    | "url-list"
    | "synthetic-email"
    | "synthetic-audio";
  repo?: string;
  ref?: string;
  subdir?: string;
  specUrl?: string;
  seedRange?: [number, number];
  width?: number;
  height?: number;
  format?: "jpg" | "png" | "webp";
  urls?: string[];
  emailCount?: number;
}

interface Manifest {
  version: number;
  sources: ManifestSource[];
}

const manifest: Manifest = JSON.parse(readFileSync(path.join(HERE, "manifest.json"), "utf-8"));

async function main() {
  const selected =
    ONLY.length > 0 ? manifest.sources.filter((src) => ONLY.includes(src.id)) : manifest.sources;
  if (selected.length === 0) {
    console.error(`No sources matched --only=${ONLY.join(",")}`);
    process.exit(1);
  }

  for (const src of selected) {
    console.log(`\n=== ${src.id} — ${src.label} (${src.license}) ===`);
    const targetAbs = path.join(HERE, src.targetDir);
    mkdirSync(targetAbs, { recursive: true });

    try {
      if (src.strategy === "github-tarball-subdir") {
        await fetchGithubTarballSubdir(src, targetAbs);
      } else if (src.strategy === "commonmark-spec-split") {
        await fetchCommonmarkSpec(src, targetAbs);
      } else if (src.strategy === "picsum") {
        await fetchPicsum(src, targetAbs);
      } else if (src.strategy === "url-list") {
        await fetchUrlList(src, targetAbs);
      } else if (src.strategy === "synthetic-email") {
        await generateSyntheticEmail(src, targetAbs);
      } else if (src.strategy === "synthetic-audio") {
        await generateSyntheticAudio(src, targetAbs);
      } else {
        throw new Error(`Unknown strategy: ${(src as ManifestSource).strategy}`);
      }
    } catch (err) {
      if (src.optional) {
        console.warn(`  (optional) ${src.id} failed — skipping: ${(err as Error).message}`);
        continue;
      }
      throw err;
    }

    const count = await countFiles(targetAbs);
    console.log(`  ✓ ${count} files in ${src.targetDir}`);
    if (src.expectedFileCountMin !== undefined && count < src.expectedFileCountMin) {
      console.warn(`  ⚠ expected ≥${src.expectedFileCountMin} files, got ${count}`);
    }
  }

  console.log("\nFetch complete. Run `pnpm corpus:seed` to push into Helix.");
}

async function fetchGithubTarballSubdir(src: ManifestSource, targetAbs: string) {
  const { repo, ref, subdir } = src;
  if (!repo || !ref || !subdir) throw new Error(`Missing repo/ref/subdir for ${src.id}`);

  if (!FORCE) {
    const existing = await countFiles(targetAbs);
    if (existing > 0) {
      console.log(`  ✓ ${existing} files already present (use --force to refetch)`);
      return;
    }
  }

  const tmp = await mkdtemp(path.join(tmpdir(), `helix-corpus-${src.id}-`));
  try {
    const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
    console.log(`  Downloading ${url} …`);
    const tarPath = path.join(tmp, "src.tar.gz");
    await downloadToFile(url, tarPath);
    const tarSize = statSync(tarPath).size;
    console.log(`  ↳ ${(tarSize / 1_000_000).toFixed(1)} MB`);

    const leaf = repo.split("/")[1];
    const archiveRoot = `${leaf}-${ref}`;
    const pathInArchive = `${archiveRoot}/${subdir}`;
    console.log(`  Extracting ${pathInArchive}/ …`);
    execFileSync("tar", ["-xzf", tarPath, "-C", tmp, pathInArchive], { stdio: "inherit" });
    const extracted = path.join(tmp, pathInArchive);
    if (!existsSync(extracted)) {
      throw new Error(`Subdir not found in archive: ${pathInArchive}`);
    }
    await moveTreeContents(extracted, targetAbs);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function fetchCommonmarkSpec(src: ManifestSource, targetAbs: string) {
  if (!src.specUrl) throw new Error(`Missing specUrl for ${src.id}`);
  if (!FORCE) {
    const existing = await countFiles(targetAbs);
    if (existing > 50) {
      console.log(`  ✓ ${existing} files already present (use --force to refetch)`);
      return;
    }
  }
  console.log(`  Downloading ${src.specUrl} …`);
  const res = await fetch(src.specUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${src.specUrl}`);
  const text = await res.text();

  // CommonMark spec uses 32-backtick fences around each example: input, ".", expected output.
  const fenceRe = /^[`]{32}[^\n]*\n([\s\S]*?)\n\.\n[\s\S]*?\n[`]{32}/gm;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = fenceRe.exec(text)) !== null) {
    idx += 1;
    const input = (match[1] ?? "").replace(/→/g, "\t");
    const filename = `commonmark-example-${idx.toString().padStart(4, "0")}.md`;
    await writeFile(path.join(targetAbs, filename), input, "utf-8");
  }
  await writeFile(path.join(targetAbs, "commonmark-spec-full.md"), text, "utf-8");
}

async function fetchPicsum(src: ManifestSource, targetAbs: string) {
  const [from, to] = src.seedRange ?? [1, 100];
  const w = src.width ?? 1200;
  const h = src.height ?? 800;
  const ext = src.format ?? "jpg";
  const total = to - from + 1;
  let done = 0;
  let skipped = 0;

  for (let seed = from; seed <= to; seed++) {
    const outPath = path.join(
      targetAbs,
      `picsum-${seed.toString().padStart(4, "0")}-${w}x${h}.${ext}`,
    );
    if (!FORCE && existsSync(outPath) && statSync(outPath).size > 1000) {
      skipped += 1;
      continue;
    }
    const url = `https://picsum.photos/seed/${seed}/${w}/${h}.${ext}`;
    try {
      await downloadToFile(url, outPath);
      done += 1;
      if (done % 10 === 0) process.stdout.write(`  ${done}/${total}\r`);
    } catch (err) {
      console.warn(`\n  ⚠ seed=${seed} failed: ${(err as Error).message}`);
    }
  }
  console.log(`  ✓ downloaded ${done}, skipped ${skipped} (cached)`);
}

async function downloadToFile(url: string, outPath: string) {
  // execFile, not exec — no shell interpolation. URL comes from checked-in manifest.
  execFileSync(
    "curl",
    ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", outPath, url],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

/** Fetch a static list of URLs. Used for small, hand-curated sample sets
 *  (audio/video) where we want named files rather than generated content. */
async function fetchUrlList(src: ManifestSource, targetAbs: string) {
  const urls = src.urls ?? [];
  if (urls.length === 0) throw new Error(`url-list source ${src.id} has no urls`);
  let done = 0;
  let skipped = 0;
  for (const url of urls) {
    const filename = decodeURIComponent(url.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]+/g, "_") || "file";
    const outPath = path.join(targetAbs, filename);
    if (!FORCE && existsSync(outPath) && statSync(outPath).size > 1000) {
      skipped += 1;
      continue;
    }
    try {
      await downloadToFile(url, outPath);
      done += 1;
    } catch (err) {
      console.warn(`  ⚠ ${url} failed: ${(err as Error).message}`);
    }
  }
  console.log(`  ✓ downloaded ${done}, skipped ${skipped} (cached)`);
}

/** Generate N synthetic .eml files with realistic variety:
 *  - 50% multipart/alternative (HTML + plain)
 *  - 25% plain-text only
 *  - 25% with attachments (PNG, PDF stub, TXT)
 *  Deterministic via a seeded PRNG so the same N always produces the same bytes
 *  — diffs and snapshot tests stay stable. */
async function generateSyntheticEmail(src: ManifestSource, targetAbs: string) {
  const count = src.emailCount ?? 300;

  if (!FORCE) {
    const existing = await countFiles(targetAbs);
    if (existing >= count) {
      console.log(`  ✓ ${existing} files already present (use --force to regenerate)`);
      return;
    }
  }

  // Mulberry32 — small, fast, deterministic. Seed is fixed so each corpus
  // generation is byte-identical across machines.
  let seed = 0xC0FFEE;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const firstNames = ["Ada","Grace","Linus","Sundar","Margaret","Bjarne","Hedy","Don","Barbara","Tim","Vint","Radia","Katherine","Brendan","Anita","Mary","Donald","Ken","Brian","Dennis"];
  const lastNames = ["Lovelace","Hopper","Torvalds","Pichai","Hamilton","Stroustrup","Lamarr","Knuth","Liskov","Berners-Lee","Cerf","Perlman","Johnson","Eich","Borg","Jackson","Knuth","Thompson","Kernighan","Ritchie"];
  const domains = ["acme.example","contoso.example","initech.example","umbrella.example","stark.example","wayne.example","cyberdyne.example","tyrell.example"];
  const subjectStems = [
    "Q3 planning sync follow-up","Re: design review draft","Customer escalation #","RFC: API versioning","Welcome to the team",
    "Weekly status:","Action required:","Heads up:","Quick question on","Re: invoice","FYI:","Re: roadmap","Sprint retro notes",
    "Re: incident postmortem","New hire onboarding","Vendor contract renewal","Out of office","Re: latency regression","Re: deploy plan",
    "Re: feature flag","[security] CVE update","Re: budget","Customer feedback summary","Re: weekly metrics","Re: pricing proposal",
  ];
  const plainBodies = [
    "Hi {name},\n\nQuick note — can you take a look at this when you have a moment? No rush, just want to make sure we're aligned before Friday.\n\nThanks,\n{author}\n",
    "Hey {name},\n\nFollowing up on our conversation. The proposal looks good overall but I had a couple of clarifying questions:\n\n  1. What's the expected timeline?\n  2. Who owns the migration step?\n  3. Are we OK with the cost projection?\n\nLet me know what you think.\n\n— {author}\n",
    "Team,\n\nReminder that we've got the {topic} review at 2pm tomorrow. Please come prepared with your section drafts.\n\nAgenda: see attached.\n\n{author}\n",
    "{name},\n\nThe customer escalation has been resolved. Root cause was a misconfiguration in the staging environment that leaked into prod during the last release window. Mitigation deployed, incident closed.\n\nFull writeup in the postmortem doc.\n\n{author}\n",
    "Hi all,\n\nI'll be OOO from Thursday through Monday. {name} is the backup on-call. Please ping them for anything urgent during that window.\n\nCheers,\n{author}\n",
  ];
  const topics = ["docs","auth","billing","scim","calendar","drive","ai-routing","ingest","versioning","federation"];

  for (let i = 0; i < count; i++) {
    const senderFirst = pick(firstNames);
    const senderLast = pick(lastNames);
    const recvFirst = pick(firstNames);
    const recvLast = pick(lastNames);
    const senderDomain = pick(domains);
    const recvDomain = pick(domains);
    const sender = `${senderFirst} ${senderLast} <${senderFirst.toLowerCase()}.${senderLast.toLowerCase()}@${senderDomain}>`;
    const recv = `${recvFirst} ${recvLast} <${recvFirst.toLowerCase()}.${recvLast.toLowerCase()}@${recvDomain}>`;
    const cc = rand() < 0.3
      ? `${pick(firstNames)}.${pick(lastNames)}@${pick(domains)}`.toLowerCase()
      : null;
    const subject = `${pick(subjectStems)}${pick(subjectStems).startsWith("Customer escalation") ? Math.floor(rand() * 9000 + 1000) : ""}`.trim();
    const topic = pick(topics);
    const plainTemplate = pick(plainBodies);
    const plainBody = plainTemplate
      .replace(/\{name\}/g, recvFirst)
      .replace(/\{author\}/g, senderFirst)
      .replace(/\{topic\}/g, topic);
    // Date: spread over the last 2 years from 2024-01-01.
    const epoch = Date.UTC(2024, 0, 1) + Math.floor(rand() * 730 * 24 * 3600 * 1000);
    const date = new Date(epoch).toUTCString();
    const messageId = `<msg-${i.toString().padStart(5, "0")}.${seed.toString(16)}@${senderDomain}>`;

    const variant = i % 4; // 0,1,2,3 — 50% multipart, 25% plain, 25% with attachment
    let body: string;
    if (variant === 2) {
      // plain-text only
      body = [
        `From: ${sender}`,
        `To: ${recv}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        plainBody,
      ].filter((x) => x !== null).join("\r\n");
    } else if (variant === 3) {
      // multipart/mixed with attachment (small synthetic .txt)
      const boundary = `=_attach_${(seed >>> 0).toString(16)}`;
      const attachment = `Synthetic attachment ${i}\nTopic: ${topic}\nGenerated by Helix test corpus.\n`;
      const attachmentB64 = Buffer.from(attachment, "utf-8").toString("base64");
      body = [
        `From: ${sender}`,
        `To: ${recv}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        plainBody,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8; name="notes-${topic}.txt"`,
        `Content-Disposition: attachment; filename="notes-${topic}.txt"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        attachmentB64,
        `--${boundary}--`,
      ].filter((x) => x !== null).join("\r\n");
    } else {
      // multipart/alternative (HTML + plain) — the realistic majority case
      const boundary = `=_alt_${(seed >>> 0).toString(16)}`;
      const htmlBody = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#222">
<p>Hi <strong>${recvFirst}</strong>,</p>
<p>${plainBody.split("\n\n")[1] ?? plainBody.replace(/\n/g, " ")}</p>
<p>Best,<br/><em>${senderFirst}</em></p>
<hr/>
<p style="font-size:11px;color:#888">This is a synthetic test email (#${i}) from the Helix dev corpus. Topic: ${topic}.</p>
</body></html>`;
      body = [
        `From: ${sender}`,
        `To: ${recv}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        plainBody,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        htmlBody,
        `--${boundary}--`,
      ].filter((x) => x !== null).join("\r\n");
    }

    const filename = `email-${i.toString().padStart(4, "0")}-${topic}.eml`;
    await writeFile(path.join(targetAbs, filename), body, "utf-8");
  }
  console.log(`  ✓ generated ${count} .eml files`);
}

async function moveTreeContents(srcDir: string, destDir: string) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      await moveTreeContents(src, dest);
    } else {
      await rename(src, dest);
    }
  }
}

/** Generate small playable WAV files (mono 16-bit PCM, sine wave).
 *  Pure Node — no ffmpeg dependency, deterministic. Useful for verifying the
 *  audio editor surface plays back without shipping copyrighted audio. */
async function generateSyntheticAudio(src: ManifestSource, targetAbs: string) {
  const samples = [
    { name: "tone-440hz-1s.wav", freq: 440, duration: 1.0, sampleRate: 22050 },
    { name: "tone-880hz-1s.wav", freq: 880, duration: 1.0, sampleRate: 22050 },
    { name: "tone-220hz-2s.wav", freq: 220, duration: 2.0, sampleRate: 22050 },
    { name: "tone-1000hz-1s.wav", freq: 1000, duration: 1.0, sampleRate: 44100 },
    { name: "chime-arpeggio-2s.wav", freq: 0, duration: 2.0, sampleRate: 22050 },
  ];

  if (!FORCE) {
    const existing = await countFiles(targetAbs);
    if (existing >= samples.length) {
      console.log(`  ✓ ${existing} files already present (use --force to regenerate)`);
      return;
    }
  }

  for (const s of samples) {
    const total = Math.round(s.duration * s.sampleRate);
    const pcm = Buffer.alloc(total * 2);
    for (let i = 0; i < total; i++) {
      let v: number;
      if (s.freq === 0) {
        // arpeggio: cycle through C-E-G-C across the duration
        const notes = [261.63, 329.63, 392.0, 523.25];
        const noteIdx = Math.min(notes.length - 1, Math.floor((i / total) * notes.length));
        const fade = Math.sin((Math.PI * (i % (total / notes.length))) / (total / notes.length));
        v = Math.sin((2 * Math.PI * notes[noteIdx]! * i) / s.sampleRate) * fade * 0.4;
      } else {
        // fade-in/fade-out envelope so it doesn't click at start/end
        const env = Math.min(1, Math.min(i, total - i) / (s.sampleRate * 0.02));
        v = Math.sin((2 * Math.PI * s.freq * i) / s.sampleRate) * env * 0.4;
      }
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // PCM chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(s.sampleRate, 24);
    header.writeUInt32LE(s.sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    await writeFile(path.join(targetAbs, s.name), Buffer.concat([header, pcm]));
  }
  console.log(`  ✓ generated ${samples.length} .wav files`);
}

async function countFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else count += 1;
    }
  }
  return count;
}

main().catch((err) => {
  console.error("\nfetch failed:", err);
  process.exit(1);
});
