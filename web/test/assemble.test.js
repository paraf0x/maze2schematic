import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { makeRng } from "../js/rng.js";
import { generateMaze, defaultOptions } from "../js/generate.js";
import { parseLitematic, stateKey, AIR } from "../js/litematic.js";
import { TileSet } from "../js/tiles.js";
import { parseVariantsConfig } from "../js/variants.js";
import { assignStyles, assembleBlocks } from "../js/assemble.js";

const loadDoc = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));
function tileset() {
  const files = ["deadend/deadend", "deadend/deadend_slim", "straight/straight", "straight/straight_slim",
    "turn/turn", "turn/turn_slim", "tcross/tcross", "tcross/tcross_slim",
    "xcross/xcross", "xcross/xcross_slim", "closed/closed", "closed/closed_slim"];
  const entries = files.map((f) => ({ filename: f.split("/")[1] + ".litematic", doc: loadDoc(`presets/${f}.litematic`) }));
  return TileSet.fromEntries(entries, parseVariantsConfig(JSON.parse(readFileSync("presets/variants.json", "utf8"))));
}

test("assignStyles: every cell has a style, slim share roughly follows weight", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(1));
  const grid = assignStyles(maze, ts, makeRng(1));
  assert.equal(grid.length, maze.rows);
  let slim = 0, total = 0;
  for (const row of grid) for (const s of row) { total++; if (s === "slim") slim++; }
  assert.equal(total, maze.rows * maze.cols);
  const weights = ts.styleWeights();
  const expected = weights.slim / (weights.slim + weights[""]);
  assert.ok(Math.abs(slim / total - expected) < 0.2, `slim share ${slim / total} vs ${expected}`);
});

test("assignStyles: slim clusters are connected and within min/max", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(2));
  const grid = assignStyles(maze, ts, makeRng(2));
  const { minSize, maxSize } = ts.clusters.slim;
  const seen = new Set();
  for (let r = 0; r < maze.rows; r++) for (let c = 0; c < maze.cols; c++) {
    if (grid[r][c] !== "slim" || seen.has(r + "," + c)) continue;
    // Flood fill along the corridors (clusters only grow over open edges)
    const cluster = [];
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const key = cr + "," + cc;
      if (seen.has(key)) continue;
      seen.add(key);
      cluster.push([cr, cc]);
      for (const d of maze.masks[cr][cc]) {
        const nr = cr + (d === 2 ? 1 : 0) - (d === 0 ? 1 : 0);
        const nc = cc + (d === 1 ? 1 : 0) - (d === 3 ? 1 : 0);
        if (nr >= 0 && nr < maze.rows && nc >= 0 && nc < maze.cols && grid[nr][nc] === "slim") stack.push([nr, nc]);
      }
    }
    assert.ok(cluster.length >= minSize && cluster.length <= maxSize,
      `Cluster at ${r},${c}: ${cluster.length} not in [${minSize},${maxSize}]`);
  }
});

test("assembleBlocks: size, palette, determinism", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(3));
  const a = assembleBlocks(maze, ts, makeRng(3));
  assert.equal(a.sizeX, maze.cols * ts.size);
  assert.equal(a.sizeZ, maze.rows * ts.size);
  assert.equal(a.sizeY, ts.height);
  assert.equal(a.blocks.length, a.sizeX * a.sizeY * a.sizeZ);
  assert.equal(stateKey(a.palette[0]), stateKey(AIR));
  assert.ok(a.palette.length >= 2);
  const b = assembleBlocks(maze, ts, makeRng(3));
  assert.deepEqual([...a.blocks], [...b.blocks]);
});
