import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { gzip, gunzip, supportsCompression } from "../js/export.js";

test("gzip-Roundtrip und Kompatibilitaet mit node:zlib", async () => {
  assert.ok(supportsCompression());
  const data = new Uint8Array(10000).map((_, i) => i % 251);
  const zipped = await gzip(data);
  assert.ok(zipped.length < data.length);
  assert.deepEqual([...(await gunzip(zipped))], [...data]);
  assert.deepEqual([...gunzipSync(zipped)], [...data]); // echtes gzip-Format
});
