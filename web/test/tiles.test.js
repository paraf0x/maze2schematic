import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseLitematic, stateKey } from "../js/litematic.js";
import { TileSet, TileError, rotateStateCw, rotatedCw, tileFromParsed, styleOf, DEFAULT_STYLE } from "../js/tiles.js";
import { parseVariantsConfig } from "../js/variants.js";

const loadDoc = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));

function presetEntries() {
  const files = [
    "presets/deadend/deadend.litematic", "presets/deadend/deadend_slim.litematic",
    "presets/straight/straight.litematic", "presets/straight/straight_slim.litematic",
    "presets/turn/turn.litematic", "presets/turn/turn_slim.litematic",
    "presets/tcross/tcross.litematic", "presets/tcross/tcross_slim.litematic",
    "presets/xcross/xcross.litematic", "presets/xcross/xcross_slim.litematic",
    "presets/closed/closed.litematic", "presets/closed/closed_slim.litematic",
  ];
  return files.map((p) => ({ filename: p.split("/").pop(), doc: loadDoc(p) }));
}
const config = () => parseVariantsConfig(JSON.parse(readFileSync("presets/variants.json", "utf8")));

test("rotateStateCw dreht facing/axis/rotation/rails/side-props", () => {
  assert.equal(rotateStateCw({ id: "a", props: { facing: "north" } }).props.facing, "east");
  assert.equal(rotateStateCw({ id: "a", props: { axis: "x" } }).props.axis, "z");
  assert.equal(rotateStateCw({ id: "a", props: { axis: "y" } }).props.axis, "y");
  assert.equal(rotateStateCw({ id: "a", props: { rotation: "14" } }).props.rotation, "2");
  assert.equal(rotateStateCw({ id: "a", props: { shape: "north_east" } }).props.shape, "south_east");
  const fence = rotateStateCw({ id: "f", props: { north: "true", east: "false", south: "true", west: "false" } });
  assert.deepEqual(
    [fence.props.north, fence.props.east, fence.props.south, fence.props.west],
    ["false", "true", "false", "true"],
  );
});

test("4x rotatedCw ist Identitaet (echtes Preset-Tile)", () => {
  const tile = tileFromParsed(loadDoc("presets/turn/turn.litematic"), "turn");
  let t = tile;
  for (let i = 0; i < 4; i++) t = rotatedCw(t);
  for (let x = 0; x < tile.size; x++)
    for (let y = 0; y < tile.height; y++)
      for (let z = 0; z < tile.size; z++)
        assert.equal(stateKey(t.blocks[x][y][z]), stateKey(tile.blocks[x][y][z]));
});

test("styleOf trennt Alias und Style", () => {
  assert.equal(styleOf("straight", "straight"), DEFAULT_STYLE);
  assert.equal(styleOf("straight_slim", "straight"), "slim");
  assert.equal(styleOf("fancy", "straight"), "fancy");
});

test("TileSet aus Presets: Groesse, Styles, Rotation-Cache", () => {
  const ts = TileSet.fromEntries(presetEntries(), config());
  assert.ok(ts.size > 0 && ts.height > 0);
  assert.ok(Object.keys(ts.variants).includes("tee")); // tcross-Alias aufgeloest
  const t0 = ts.get("turn", 1, "slim");
  const t1 = ts.get("turn", 1, "slim");
  assert.equal(t0, t1); // gecacht
  assert.equal(ts.get("turn", 5, DEFAULT_STYLE), ts.get("turn", 1, DEFAULT_STYLE)); // rotation % 4
});

test("TileSet: fehlende Pflicht-Tiles werfen TileError", () => {
  const entries = presetEntries().filter((e) => !e.filename.startsWith("xcross"));
  assert.throws(() => TileSet.fromEntries(entries, config()), TileError);
});

test("parseVariantsConfig: echtes variants.json + Fehlerfaelle", () => {
  const c = config();
  assert.ok(c.clusters.slim.minSize >= 1);
  assert.ok(c.clusters.slim.maxSize >= c.clusters.slim.minSize);
  assert.throws(() => parseVariantsConfig({ weights: { a: -1 } }), TileError);
  assert.throws(() => parseVariantsConfig({ clusters: { s: { min: 5, max: 2 } } }), TileError);
  // altes flaches Format
  assert.deepEqual(parseVariantsConfig({ straight: 3 }).weights, { straight: 3 });
});

test("TileSet: fehlendes optionales closed-Tile wird synthetisiert (voll, keine Luft)", () => {
  const entries = presetEntries().filter((e) => !e.filename.startsWith("closed"));
  const ts = TileSet.fromEntries(entries, config());
  const closed = ts.get("closed", 0, DEFAULT_STYLE);
  for (let x = 0; x < closed.size; x++)
    for (let y = 0; y < closed.height; y++)
      for (let z = 0; z < closed.size; z++)
        assert.notEqual(closed.blocks[x][y][z].id, "minecraft:air");
});
