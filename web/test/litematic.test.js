import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseLitematic, writeLitematic, stateKey, AIR } from "../js/litematic.js";

const load = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));

test("liest ein echtes Preset-Tile", () => {
  const doc = load("presets/straight/straight.litematic");
  assert.equal(doc.regions.length, 1);
  const r = doc.regions[0];
  assert.equal(r.sizeX, r.sizeZ); // Tiles sind quadratisch
  const corner = r.get(0, 0, 0);
  assert.ok(typeof corner.id === "string" && corner.id.startsWith("minecraft:"));
});

test("liest das grosse maze.litematic und findet Luft + Stein", () => {
  const r = load("maze.litematic").regions[0];
  assert.equal(r.sizeX, 100);
  assert.equal(r.sizeY, 3);
  const ids = new Set();
  for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) ids.add(r.get(x, 1, z).id);
  assert.ok(ids.size >= 2); // mindestens Luft + Wandmaterial
});

test("write -> parse Roundtrip", () => {
  const stone = { id: "minecraft:stone", props: {} };
  const stairs = { id: "minecraft:oak_stairs", props: { facing: "north", half: "bottom" } };
  const palette = [AIR, stone, stairs];
  const [sx, sy, sz] = [3, 2, 3];
  const blocks = new Uint32Array(sx * sy * sz);
  blocks[(0 * sz + 0) * sx + 0] = 1;            // (0,0,0) Stein
  blocks[(1 * sz + 2) * sx + 2] = 2;            // (2,1,2) Treppe
  const bytes = writeLitematic({
    name: "t", author: "test", sizeX: sx, sizeY: sy, sizeZ: sz,
    palette, blocks, timestamp: 1785228778445,
  });
  const doc = parseLitematic(bytes);
  assert.equal(doc.name, "t");
  const r = doc.regions[0];
  assert.deepEqual(r.get(0, 0, 0), stone);
  assert.deepEqual(r.get(2, 1, 2), stairs);
  assert.deepEqual(r.get(1, 0, 1), AIR);
});

test("Palette > 4 Eintraege erzwingt mehr Bits (Spill ueber Long-Grenzen)", () => {
  const palette = [AIR];
  for (let i = 1; i <= 20; i++) palette.push({ id: `minecraft:b${i}`, props: {} });
  const [sx, sy, sz] = [7, 3, 5]; // 105 Eintraege * 5 bits = 525 bits, spannt Longs
  const blocks = new Uint32Array(sx * sy * sz).map((_, i) => i % 21);
  const doc = parseLitematic(writeLitematic({
    name: "p", author: "t", sizeX: sx, sizeY: sy, sizeZ: sz,
    palette, blocks, timestamp: 0,
  }));
  const r = doc.regions[0];
  let i = 0;
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    assert.equal(stateKey(r.get(x, y, z)), stateKey(palette[i % 21]), `Index ${i}`);
    i++;
  }
});
