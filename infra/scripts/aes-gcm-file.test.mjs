#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "helix-aes-gcm-"));
const helper = new URL("./aes-gcm-file.mjs", import.meta.url);
const source = join(root, "source.tar.gz");
const encrypted = join(root, "backup.kms");
const wrapped = join(root, "backup.kms.datakey");
const restored = join(root, "restored.tar.gz");
const key = randomBytes(32).toString("base64");
const plaintext = randomBytes(128 * 1024);
try {
  await writeFile(source, plaintext);
  const encryption = spawnSync(
    process.execPath,
    [helper.pathname, "encrypt", source, encrypted, wrapped],
    {
      input: JSON.stringify({ Plaintext: key, CiphertextBlob: "wrapped-test-key" }),
      encoding: "utf8",
    },
  );
  assert.equal(encryption.status, 0, encryption.stderr);
  assert.equal((await readFile(wrapped, "utf8")).trim(), "wrapped-test-key");
  const decryption = spawnSync(
    process.execPath,
    [helper.pathname, "decrypt", encrypted, restored],
    {
      input: key,
      encoding: "utf8",
    },
  );
  assert.equal(decryption.status, 0, decryption.stderr);
  assert.deepEqual(await readFile(restored), plaintext);
  // Exercise the shell KMS boundary for both new and explicitly selected legacy archives.
  const bin = join(root, "bin");
  await mkdir(bin);
  const aws = join(bin, "aws");
  await writeFile(
    aws,
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.TEST_KMS_KEY + "\\n");\n',
  );
  await chmod(aws, 0o755);
  await writeFile(wrapped, Buffer.from("wrapped-key").toString("base64"));
  const decrypt = (format) =>
    spawnSync(
      "bash",
      [
        "-c",
        'set -Eeuo pipefail; SCRIPT_DIR=$1; source "$SCRIPT_DIR/common.sh"; kms_decrypt_file "$2" "$3" "$4" "$5"',
        "kms-test",
        new URL(".", import.meta.url).pathname,
        encrypted,
        restored,
        wrapped,
        format,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_KMS_KEY: key },
      },
    );
  assert.equal(decrypt("ed25519").status, 0);
  assert.deepEqual(await readFile(restored), plaintext);
  const legacy = join(root, "legacy.kms");
  const legacyEncryption = spawnSync(
    "openssl",
    ["enc", "-aes-256-cbc", "-pbkdf2", "-in", source, "-out", legacy, "-pass", "stdin"],
    { input: `${key}\n`, encoding: "utf8" },
  );
  assert.equal(legacyEncryption.status, 0, legacyEncryption.stderr);
  const gcm = await readFile(encrypted);
  await writeFile(encrypted, await readFile(legacy));
  assert.notEqual(
    decrypt("ed25519").status,
    0,
    "legacy encryption must not trigger automatic fallback",
  );
  assert.equal(decrypt("hmac-v3").status, 0);
  assert.deepEqual(await readFile(restored), plaintext);
  await writeFile(encrypted, gcm);
  const tampered = await readFile(encrypted);
  tampered[Math.floor(tampered.byteLength / 2)] ^= 1;
  await writeFile(encrypted, tampered);
  const rejected = spawnSync(process.execPath, [helper.pathname, "decrypt", encrypted, restored], {
    input: key,
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0, "tampered ciphertext must fail authentication");
  console.log("AES-GCM file encryption validation passed");
} finally {
  await rm(root, { force: true, recursive: true });
}
