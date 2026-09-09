#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, open, rename, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("HELIXKMS1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function keyFromBase64(value) {
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32) throw new Error("KMS plaintext data key must be 32 bytes");
  return key;
}

async function encrypt(source, destination, wrappedKeyPath) {
  const dataKey = JSON.parse(await stdin());
  const key = keyFromBase64(dataKey.Plaintext);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  await writeFile(destination, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
  try {
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(destination, { flags: "a", mode: 0o600 }),
    );
    await appendFile(destination, cipher.getAuthTag());
    await writeFile(wrappedKeyPath, `${dataKey.CiphertextBlob}\n`, { mode: 0o600 });
  } finally {
    key.fill(0);
  }
}

async function decrypt(source, destination) {
  const key = keyFromBase64(await stdin());
  try {
    const file = await open(source, "r");
    const header = Buffer.alloc(MAGIC.byteLength + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    let size;
    try {
      ({ size } = await file.stat());
      if (size <= header.byteLength + TAG_BYTES) throw new Error("ciphertext is truncated");
      await file.read(header, 0, header.byteLength, 0);
      await file.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
      await file.close();
    }
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("invalid ciphertext format");
    }

    const temporary = `${destination}.partial-${process.pid}`;
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.byteLength));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(source, {
          start: header.byteLength,
          end: size - TAG_BYTES - 1,
        }),
        decipher,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } finally {
    key.fill(0);
  }
}

const [operation, source, destination, wrappedKeyPath] = process.argv.slice(2);
if (operation === "encrypt" && source && destination && wrappedKeyPath) {
  await encrypt(source, destination, wrappedKeyPath);
} else if (operation === "decrypt" && source && destination) {
  await decrypt(source, destination);
} else {
  throw new Error(
    "usage: aes-gcm-file.mjs encrypt <source> <destination> <wrapped-key> | decrypt <source> <destination>",
  );
}
