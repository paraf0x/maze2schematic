import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { serializeTheme, deserializeTheme } from "../js/themes.js";

// Requires web/themes/ to exist -- run scripts/make_web_themes.py first.
const tileBytes = new Uint8Array(gunzipSync(readFileSync("web/themes/classic/straight.litematic")));
const otherTileBytes = new Uint8Array(gunzipSync(readFileSync("web/themes/classic/turn.litematic")));

function sampleTheme() {
  return {
    id: "my-theme",
    label: "My Theme",
    tiles: [
      { filename: "straight.litematic", bytes: tileBytes },
      { filename: "turn.litematic", bytes: otherTileBytes },
    ],
    weights: { straight: 3, straight_slim: 1 },
    disabled: ["closed_slim"],
    clusters: { slim: { minSize: 3, maxSize: 8 } },
  };
}

// Simulates the JSON.stringify/JSON.parse round trip localStorage forces.
const throughJson = (v) => JSON.parse(JSON.stringify(v));

test("serializeTheme: produces JSON-safe shape with base64 tile data", () => {
  const json = serializeTheme(sampleTheme());
  assert.equal(json.id, "my-theme");
  assert.equal(json.label, "My Theme");
  assert.equal(json.tiles.length, 2);
  for (const tile of json.tiles) {
    assert.equal(typeof tile.data, "string");
    assert.match(tile.data, /^[A-Za-z0-9+/]*={0,2}$/);
  }
  // Must survive an actual JSON.stringify (what localStorage.setItem gets).
  assert.doesNotThrow(() => JSON.stringify(json));
});

test("serializeTheme/deserializeTheme: roundtrip preserves tile bytes exactly", () => {
  const original = sampleTheme();
  const back = deserializeTheme(throughJson(serializeTheme(original)));

  assert.equal(back.id, original.id);
  assert.equal(back.label, original.label);
  assert.equal(back.tiles.length, 2);
  assert.equal(back.tiles[0].filename, "straight.litematic");
  assert.deepEqual([...back.tiles[0].bytes], [...tileBytes]);
  assert.equal(back.tiles[1].filename, "turn.litematic");
  assert.deepEqual([...back.tiles[1].bytes], [...otherTileBytes]);
});

test("serializeTheme/deserializeTheme: roundtrip preserves weights/disabled/clusters", () => {
  const original = sampleTheme();
  const back = deserializeTheme(throughJson(serializeTheme(original)));

  assert.deepEqual(back.weights, original.weights);
  assert.deepEqual(back.disabled, original.disabled);
  assert.deepEqual(back.clusters, original.clusters);
});

test("deserializeTheme: corrupted base64 tile data throws a clean, per-tile error", () => {
  const json = serializeTheme(sampleTheme());
  json.tiles[0].data = "not-valid-base64!!";
  assert.throws(() => deserializeTheme(json), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /straight\.litematic/);
    assert.match(err.message, /corrupted/i);
    return true;
  });
});

test("deserializeTheme: rejects structurally invalid input instead of crashing", () => {
  assert.throws(() => deserializeTheme(null), /Invalid theme/);
  assert.throws(() => deserializeTheme(undefined), /Invalid theme/);
  assert.throws(() => deserializeTheme("not an object"), /Invalid theme/);
  assert.throws(() => deserializeTheme({ label: "X", tiles: [] }), /id/);
  assert.throws(() => deserializeTheme({ id: "x", tiles: [] }), /label/);
  assert.throws(() => deserializeTheme({ id: "x", label: "X" }), /tile list/);
  assert.throws(
    () => deserializeTheme({ id: "x", label: "X", tiles: [{ filename: "a.litematic" }] }),
    /missing its data/,
  );
});

test("deserializeTheme: tolerant defaults for missing weights/disabled/clusters", () => {
  const back = deserializeTheme({ id: "x", label: "X", tiles: [] });
  assert.deepEqual(back.weights, {});
  assert.deepEqual(back.disabled, []);
  assert.deepEqual(back.clusters, {});
});
