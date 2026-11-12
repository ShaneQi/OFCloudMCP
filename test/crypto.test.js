import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unlockDocumentKey, decryptFile, encryptFile } from "../src/crypto.js";

test("encryptFile output decrypts back, across segment boundaries", async () => {
  const dir = new URL("./fixtures/encrypted.ofocus/", import.meta.url);
  const key = await unlockDocumentKey(readFileSync(new URL("encrypted", dir)), "pw");
  for (const size of [0, 10, 65535, 65536, 65537, 200000]) {
    const plain = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
    const enc = await encryptFile(plain, key);
    assert.deepEqual(Buffer.from(await decryptFile("x.zip", enc, key)), Buffer.from(plain), `size ${size}`);
  }
});
