import { test } from "node:test";
import assert from "node:assert/strict";
import { N, E, S, W } from "../js/generate.js";
import { drawMaze, drawTopdown, colorForBlock, BLOCK_COLORS } from "../js/preview2d.js";

// ---------------------------------------------------------------------------
// Fake canvas: no real DOM available (Node tests), so a minimal stub that
// only mimics what preview2d.js touches: clientWidth/Height (parent size,
// which drawMaze/drawTopdown sync onto canvas.width/height),
// getContext("2d") returns a fake context that records all draw calls.
// ---------------------------------------------------------------------------

function fakeCanvas(clientWidth, clientHeight) {
  const calls = { fillRect: [], moveTo: [], lineTo: [], stroke: 0, clearRect: 0, setTransform: [] };
  const ctx = {
    setTransform(...args) { calls.setTransform.push(args); },
    clearRect() { calls.clearRect++; },
    fillRect(x, y, w, h) { calls.fillRect.push({ x, y, w, h, fillStyle: ctx.fillStyle }); },
    beginPath() {},
    moveTo(x, y) { calls.moveTo.push([x, y]); },
    lineTo(x, y) { calls.lineTo.push([x, y]); },
    stroke() { calls.stroke++; },
    fillStyle: null,
    strokeStyle: null,
    lineWidth: null,
  };
  const canvas = {
    clientWidth,
    clientHeight,
    width: 0,
    height: 0,
    getContext(kind) {
      assert.equal(kind, "2d");
      return ctx;
    },
  };
  return { canvas, calls };
}

// ---------------------------------------------------------------------------
// colorForBlock / BLOCK_COLORS
// ---------------------------------------------------------------------------

test("colorForBlock: known blocks come from BLOCK_COLORS", () => {
  assert.equal(colorForBlock("minecraft:stone"), BLOCK_COLORS["minecraft:stone"]);
  assert.equal(colorForBlock("minecraft:oak_log"), BLOCK_COLORS["minecraft:oak_log"]);
  assert.equal(colorForBlock("minecraft:water"), BLOCK_COLORS["minecraft:water"]);
  assert.ok(/^#[0-9a-f]{6}$/i.test(BLOCK_COLORS["minecraft:stone"]));
});

test("colorForBlock: unknown id is deterministic (same id -> same color)", () => {
  const a = colorForBlock("minecraft:some_modded_block_xyz");
  const b = colorForBlock("minecraft:some_modded_block_xyz");
  assert.equal(a, b);
  assert.match(a, /^hsl\(\d+, 55%, 45%\)$/);
});

test("colorForBlock: different unknown ids yield (mostly) different colors", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `minecraft:fantasy_block_${i}`);
  const colors = new Set(ids.map(colorForBlock));
  // Hash collisions among 20 values in 360 hues are unlikely, but not
  // impossible -- we only require "mostly distinct".
  assert.ok(colors.size >= 18, `only ${colors.size} distinct colors among 20 ids`);
});

// ---------------------------------------------------------------------------
// drawMaze
// ---------------------------------------------------------------------------

function maskSet(...dirs) { return new Set(dirs); }

// Hand-built 2x2 maze (rows=2, cols=2):
//   (0,0) -- (0,1)
//     |        |
//   (1,0)    (1,1)
//
// (0,0): open to E and S (edges N, W closed -> 2 segments)
// (0,1): open to W and S (edges N, E closed -> 2 segments)
// (1,0): open to N (edges E, S, W closed -> 3 segments)
// (1,1): fully closed (mask.size === 0 -> 4 segments + 1 fill)
function tinyMaze() {
  return {
    rows: 2,
    cols: 2,
    masks: [
      [maskSet(E, S), maskSet(W, S)],
      [maskSet(N), maskSet()],
    ],
  };
}

test("drawMaze: syncs canvas size to clientWidth/Height", () => {
  const { canvas } = fakeCanvas(200, 100);
  drawMaze(canvas, tinyMaze());
  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 100);
});

test("drawMaze: draws the expected number of wall segments + fills", () => {
  const { canvas, calls } = fakeCanvas(200, 200);
  drawMaze(canvas, tinyMaze());

  // 2 + 2 + 3 + 4 = 11 closed edges total -> one moveTo+lineTo pair each.
  assert.equal(calls.moveTo.length, 11);
  assert.equal(calls.lineTo.length, 11);
  assert.equal(calls.stroke, 1); // one batched stroke() call

  // Exactly one fully closed cell -> exactly one fillRect.
  assert.equal(calls.fillRect.length, 1);
  const s = Math.floor(Math.min(200 / 2, 200 / 2)); // = 100
  assert.deepEqual(calls.fillRect[0], { x: 100, y: 100, w: s, h: s, fillStyle: calls.fillRect[0].fillStyle });
});

test("drawMaze: empty maze (0 rows) draws no segments and doesn't crash", () => {
  const { canvas, calls } = fakeCanvas(200, 200);
  drawMaze(canvas, { rows: 0, cols: 0, masks: [] });
  assert.equal(calls.moveTo.length, 0);
  assert.equal(calls.fillRect.length, 0);
});

// ---------------------------------------------------------------------------
// drawTopdown
// ---------------------------------------------------------------------------

// Hand-built 2x1x2 assembly (sizeX=2, sizeY=1, sizeZ=2): one air column,
// one stone column, indexed (y*sizeZ+z)*sizeX+x.
function tinyAssembly() {
  const palette = [
    { id: "minecraft:air", props: {} },
    { id: "minecraft:stone", props: {} },
  ];
  const sizeX = 2, sizeY = 1, sizeZ = 2;
  const blocks = new Uint32Array(sizeX * sizeY * sizeZ);
  // Column (x=0, z=0): air (index 0, default). Column (x=1, z=0): stone.
  blocks[(0 * sizeZ + 0) * sizeX + 1] = 1;
  // Column (x=0, z=1): air. Column (x=1, z=1): stone.
  blocks[(0 * sizeZ + 1) * sizeX + 1] = 1;
  return { sizeX, sizeY, sizeZ, palette, blocks };
}

test("drawTopdown: fills only non-air columns with the block color", () => {
  const { canvas, calls } = fakeCanvas(20, 20);
  drawTopdown(canvas, tinyAssembly());

  // Background fill over the whole canvas + 2 stone columns (x=1, z=0/1).
  const stoneColor = colorForBlock("minecraft:stone");
  const stoneFills = calls.fillRect.filter((r) => r.fillStyle === stoneColor);
  assert.equal(stoneFills.length, 2);

  const px = Math.floor(Math.min(20 / 2, 20 / 2)); // = 10
  const xs = stoneFills.map((r) => r.x).sort((a, b) => a - b);
  const zs = stoneFills.map((r) => r.y).sort((a, b) => a - b);
  assert.deepEqual(xs, [px, px]); // both at x=1 -> x*px
  assert.deepEqual(zs, [0, px]); // z=0 and z=1 -> z*px

  // No fill in stone color for the two air columns (x=0).
  assert.ok(!calls.fillRect.some((r) => r.x === 0 && r.fillStyle === stoneColor));
});

test("drawTopdown: empty assembly (sizeX=0) draws no blocks and doesn't crash", () => {
  const { canvas, calls } = fakeCanvas(20, 20);
  drawTopdown(canvas, { sizeX: 0, sizeY: 0, sizeZ: 0, palette: [], blocks: new Uint32Array(0) });
  // Only the initial background fill, no block rectangles.
  assert.equal(calls.fillRect.length, 1);
});
