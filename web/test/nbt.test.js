import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { readNbt, writeNbt, tag, TAG } from "../js/nbt.js";

test("Roundtrip eines handgebauten Compounds", () => {
  const root = tag.compound({
    Version: tag.int(6),
    Name: tag.string("maze"),
    Time: tag.long(1785228778445n),
    Vals: tag.list(TAG.INT, [tag.int(1), tag.int(2), tag.int(3)]),
    States: tag.longArray(new BigInt64Array([1n, -2n, 3n])),
    Nested: tag.compound({ x: tag.double(1.5), b: tag.byte(-1) }),
  });
  const bytes = writeNbt("", root);
  const back = readNbt(bytes);
  assert.equal(back.name, "");
  assert.equal(back.value.value.Version.value, 6);
  assert.equal(back.value.value.Name.value, "maze");
  assert.equal(back.value.value.Time.value, 1785228778445n);
  assert.deepEqual(back.value.value.Vals.value.items.map((t) => t.value), [1, 2, 3]);
  assert.deepEqual([...back.value.value.States.value], [1n, -2n, 3n]);
  assert.equal(back.value.value.Nested.value.x.value, 1.5);
  assert.equal(back.value.value.Nested.value.b.value, -1);
});

test("liest eine echte litemapy-Datei", () => {
  const raw = gunzipSync(readFileSync("maze.litematic"));
  const { value: root } = readNbt(new Uint8Array(raw));
  assert.equal(root.value.Version.value, 6);
  assert.equal(root.value.SubVersion.value, 1);
  assert.equal(root.value.MinecraftDataVersion.value, 2975);
  assert.ok(root.value.Regions.value.maze);
});

test("Byte-identischer Roundtrip der echten Datei", () => {
  const raw = new Uint8Array(gunzipSync(readFileSync("maze.litematic")));
  const { name, value } = readNbt(raw);
  const out = writeNbt(name, value);
  assert.deepEqual([...out], [...raw]);
});
