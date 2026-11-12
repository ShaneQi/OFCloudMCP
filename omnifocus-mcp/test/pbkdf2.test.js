import { test } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { pbkdf2 } from "../src/pbkdf2.js";

test("pure-JS PBKDF2 matches node:crypto", async () => {
  const salt = new Uint8Array(20).map((_, i) => i * 7);
  for (const prf of ["sha1", "sha256", "sha512"]) {
    for (const password of ["pw", "pässwörd ✓", "x".repeat(100)]) {
      const got = await pbkdf2({ password, salt, rounds: 3001, prf, keyLen: 16 });
      assert.deepEqual(Buffer.from(got), pbkdf2Sync(password, salt, 3001, 16, prf), `${prf} ${password.length}`);
    }
  }
});
