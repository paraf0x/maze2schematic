import { test } from "node:test";
import assert from "node:assert/strict";
import { N, E, S, W } from "../js/generate.js";
import {
  drawMaze,
  drawTopdown,
  drawTileThumb,
  drawArrows,
  colorForBlock,
  BLOCK_COLORS,
  ARROW_COLOR_IN,
  ARROW_COLOR_OUT,
} from "../js/preview2d.js";

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

// ---------------------------------------------------------------------------
// drawTileThumb
// ---------------------------------------------------------------------------

// Unlike drawMaze/drawTopdown, drawTileThumb reads canvas.width/height
// directly (no clientWidth/Height sync -- see the comment in preview2d.js),
// so the fake canvas only needs to provide those plus getContext("2d").
// Also stubs the path/stroke/fill methods `strokeArrow`/`drawArrows` use
// (save/restore/beginPath/moveTo/lineTo/closePath/stroke/fill), recording
// stroke() and fill() calls with the strokeStyle/fillStyle active at the
// time -- unused by the plain fill-rect tests below, but needed by the
// arrow-overlay tests further down.
function fakeThumbCanvas(width, height) {
  const calls = { fillRect: [], stroke: [], fill: [] };
  const ctx = {
    fillRect(x, y, w, h) { calls.fillRect.push({ x, y, w, h, fillStyle: ctx.fillStyle }); },
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() { calls.stroke.push(ctx.strokeStyle); },
    fill() { calls.fill.push(ctx.fillStyle); },
    fillStyle: null,
    strokeStyle: null,
    lineWidth: null,
    lineCap: null,
  };
  const canvas = {
    width,
    height,
    getContext(kind) {
      assert.equal(kind, "2d");
      return ctx;
    },
  };
  return { canvas, calls };
}

const AIR_STATE = { id: "minecraft:air", props: {} };
const STONE_STATE = { id: "minecraft:stone", props: {} };

// Hand-built 2x2x2 region: column (0,0) is fully air; the other three
// columns have stone somewhere in their y-column (found by scanning from
// the top, y = sizeY-1 downward, same as drawTopdown).
function tinyRegion() {
  return {
    sizeX: 2,
    sizeY: 2,
    sizeZ: 2,
    get(x, y, z) {
      if (x === 0 && z === 0) return AIR_STATE; // fully air column
      if (x === 1 && z === 0) return y === 1 ? STONE_STATE : AIR_STATE; // stone at top
      if (x === 0 && z === 1) return y === 0 ? STONE_STATE : AIR_STATE; // stone below top air
      return STONE_STATE; // (1,1): stone at both y layers
    },
  };
}

test("drawTileThumb: fills only non-air columns with the block color, scaled to canvas size", () => {
  const { canvas, calls } = fakeThumbCanvas(4, 4); // 2x2 region -> px = 2
  drawTileThumb(canvas, tinyRegion());

  const stoneColor = colorForBlock("minecraft:stone");
  const stoneFills = calls.fillRect.filter((r) => r.fillStyle === stoneColor);
  assert.equal(stoneFills.length, 3);

  const px = Math.floor(Math.min(4 / 2, 4 / 2)); // = 2
  const coords = stoneFills.map((r) => `${r.x},${r.y},${r.w},${r.h}`).sort();
  assert.deepEqual(
    coords,
    [`${px},0,${px},${px}`, `0,${px},${px},${px}`, `${px},${px},${px},${px}`].sort(),
  );

  // The air column (x=0, z=0) never gets the stone color.
  assert.ok(!calls.fillRect.some((r) => r.x === 0 && r.y === 0 && r.fillStyle === stoneColor));
});

test("drawTileThumb: air-only region draws only the background fill", () => {
  const { canvas, calls } = fakeThumbCanvas(4, 4);
  drawTileThumb(canvas, { sizeX: 2, sizeY: 1, sizeZ: 2, get: () => AIR_STATE });
  // Only the initial full-canvas background fill, no per-column rectangles.
  assert.equal(calls.fillRect.length, 1);
  assert.deepEqual(calls.fillRect[0], { x: 0, y: 0, w: 4, h: 4, fillStyle: calls.fillRect[0].fillStyle });
});

test("drawTileThumb: empty region (sizeX=0) draws only the background and doesn't crash", () => {
  const { canvas, calls } = fakeThumbCanvas(4, 4);
  drawTileThumb(canvas, { sizeX: 0, sizeY: 0, sizeZ: 0, get: () => AIR_STATE });
  assert.equal(calls.fillRect.length, 1);
});

// ---------------------------------------------------------------------------
// drawArrows / drawTileThumb(..., arrows)
// ---------------------------------------------------------------------------

test("drawTileThumb: arrows omitted -- no arrow paths drawn (existing behavior unchanged)", () => {
  const { canvas, calls } = fakeThumbCanvas(48, 48);
  drawTileThumb(canvas, tinyRegion());
  assert.equal(calls.stroke.length, 0);
  assert.equal(calls.fill.length, 0);
});

test("drawTileThumb: arrows=[] -- no arrow paths drawn", () => {
  const { canvas, calls } = fakeThumbCanvas(48, 48);
  drawTileThumb(canvas, tinyRegion(), []);
  assert.equal(calls.stroke.length, 0);
  assert.equal(calls.fill.length, 0);
});

test("drawTileThumb: draws an arrow path (shaft strokes + head fill) per provided arrow", () => {
  const { canvas, calls } = fakeThumbCanvas(48, 48);
  const arrows = [
    { dir: N, kind: "in" },
    { dir: E, kind: "out" },
  ];
  drawTileThumb(canvas, tinyRegion(), arrows);

  // Each arrow draws 2 strokes (outline pass + colored shaft) + 1 head
  // stroke, and fills its head once.
  assert.equal(calls.stroke.length, 3 * arrows.length);
  assert.equal(calls.fill.length, arrows.length);

  // The entrance (N, "in") is filled green; the exit (E, "out") orange.
  assert.deepEqual(calls.fill, [ARROW_COLOR_IN, ARROW_COLOR_OUT]);
});

test("drawArrows: no-op when arrows is falsy/empty", () => {
  const { canvas, calls } = fakeThumbCanvas(48, 48);
  const ctx = canvas.getContext("2d");
  drawArrows(ctx, 48, 48, null);
  drawArrows(ctx, 48, 48, []);
  assert.equal(calls.stroke.length, 0);
  assert.equal(calls.fill.length, 0);
});

test("drawArrows: unknown direction is skipped without crashing", () => {
  const { canvas, calls } = fakeThumbCanvas(48, 48);
  const ctx = canvas.getContext("2d");
  drawArrows(ctx, 48, 48, [{ dir: 99, kind: "in" }]);
  assert.equal(calls.fill.length, 0);
});
