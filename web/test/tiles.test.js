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

test("rotateStateCw rotates facing/axis/rotation/rails/side-props", () => {
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

test("4x rotatedCw is the identity (real preset tile)", () => {
  const tile = tileFromParsed(loadDoc("presets/turn/turn.litematic"), "turn");
  let t = tile;
  for (let i = 0; i < 4; i++) t = rotatedCw(t);
  for (let x = 0; x < tile.size; x++)
    for (let y = 0; y < tile.height; y++)
      for (let z = 0; z < tile.size; z++)
        assert.equal(stateKey(t.blocks[x][y][z]), stateKey(tile.blocks[x][y][z]));
});

test("styleOf separates alias and style", () => {
  assert.equal(styleOf("straight", "straight"), DEFAULT_STYLE);
  assert.equal(styleOf("straight_slim", "straight"), "slim");
  assert.equal(styleOf("fancy", "straight"), "fancy");
});

test("TileSet from presets: size, styles, rotation cache", () => {
  const ts = TileSet.fromEntries(presetEntries(), config());
  assert.ok(ts.size > 0 && ts.height > 0);
  assert.ok(Object.keys(ts.variants).includes("tee")); // tcross alias resolved
  const t0 = ts.get("turn", 1, "slim");
  const t1 = ts.get("turn", 1, "slim");
  assert.equal(t0, t1); // cached
  assert.equal(ts.get("turn", 5, DEFAULT_STYLE), ts.get("turn", 1, DEFAULT_STYLE)); // rotation % 4
});

test("TileSet: missing required tiles throw TileError", () => {
  const entries = presetEntries().filter((e) => !e.filename.startsWith("xcross"));
  assert.throws(() => TileSet.fromEntries(entries, config()), TileError);
});

test("parseVariantsConfig: real variants.json + error cases", () => {
  const c = config();
  assert.ok(c.clusters.slim.minSize >= 1);
  assert.ok(c.clusters.slim.maxSize >= c.clusters.slim.minSize);
  assert.throws(() => parseVariantsConfig({ weights: { a: -1 } }), TileError);
  assert.throws(() => parseVariantsConfig({ clusters: { s: { min: 5, max: 2 } } }), TileError);
  // old flat format
  assert.deepEqual(parseVariantsConfig({ straight: 3 }).weights, { straight: 3 });
});

test("TileSet: mixed alias families (tcross base + tee_slim variant) prefer the base", () => {
  // Regression for finding 2: "tcross.litematic" (base for the "tcross"
  // alias of "tee") together with "tee_slim.litematic" (style variant for
  // the "tee" alias) used to cause the first-listed "tee" alias family to
  // be chosen (only the style match, no base) and a spurious TileError
  // ("tee: base variant missing") to be thrown, even though
  // "tcross.litematic" is a valid base variant.
  const entries = presetEntries().filter((e) => !e.filename.startsWith("tcross"));
  const tcrossDoc = loadDoc("presets/tcross/tcross.litematic");
  entries.push({ filename: "tcross.litematic", doc: tcrossDoc });
  entries.push({ filename: "tee_slim.litematic", doc: loadDoc("presets/tcross/tcross_slim.litematic") });

  const ts = TileSet.fromEntries(entries, config());

  // "tee" gets the tcross base (an alias with a DEFAULT_STYLE match is
  // preferred); "tee_slim" belongs to the "tee" alias family and is
  // discarded, since the alias "tcross" (with a base match) was already
  // chosen for "tee".
  assert.deepEqual(Object.keys(ts.variants.tee), [DEFAULT_STYLE]);
  const teeBase = ts.get("tee", 0, DEFAULT_STYLE);
  const tcrossBase = tileFromParsed(tcrossDoc, "tcross");
  assert.equal(teeBase.size, tcrossBase.size);
  assert.equal(teeBase.height, tcrossBase.height);
  for (let x = 0; x < teeBase.size; x++)
    for (let y = 0; y < teeBase.height; y++)
      for (let z = 0; z < teeBase.size; z++)
        assert.equal(stateKey(teeBase.blocks[x][y][z]), stateKey(tcrossBase.blocks[x][y][z]));
});

test("TileSet: missing optional closed tile is synthesized (full, no air)", () => {
  const entries = presetEntries().filter((e) => !e.filename.startsWith("closed"));
  const ts = TileSet.fromEntries(entries, config());
  const closed = ts.get("closed", 0, DEFAULT_STYLE);
  for (let x = 0; x < closed.size; x++)
    for (let y = 0; y < closed.height; y++)
      for (let z = 0; z < closed.size; z++)
        assert.notEqual(closed.blocks[x][y][z].id, "minecraft:air");
});
