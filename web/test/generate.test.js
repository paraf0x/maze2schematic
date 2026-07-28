import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../js/rng.js";
import { N, E, S, W, generateMaze, defaultOptions, presetOptions, DUNGEON_PRESETS } from "../js/generate.js";

function opts(over = {}) { return { ...defaultOptions(), ...over }; }

test("Default 20x20: exact size, closed border, exactly 1 entrance top + 1 bottom", () => {
  const m = generateMaze(opts(), makeRng(1));
  assert.equal(m.cols, 20);
  assert.equal(m.rows, 20);
  let top = 0, bottom = 0;
  for (let c = 0; c < m.cols; c++) {
    if (m.masks[0][c].has(N)) top++;
    if (m.masks[m.rows - 1][c].has(S)) bottom++;
  }
  assert.equal(top, 1);
  assert.equal(bottom, 1);
  // Side borders fully closed
  for (let r = 0; r < m.rows; r++) {
    assert.ok(!m.masks[r][0].has(W));
    assert.ok(!m.masks[r][m.cols - 1].has(E));
  }
});

test("Masks are symmetric: east open <=> neighbor's west open", () => {
  const m = generateMaze(opts({ shortcuts: 0.5, coverage: 0.5, rooms: 0.5 }), makeRng(2));
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols - 1; c++) {
      assert.equal(m.masks[r][c].has(E), m.masks[r][c + 1].has(W), `at ${r},${c}`);
    }
  }
  for (let r = 0; r < m.rows - 1; r++) {
    for (let c = 0; c < m.cols; c++) {
      assert.equal(m.masks[r][c].has(S), m.masks[r + 1][c].has(N), `at ${r},${c}`);
    }
  }
});

test("Perfect maze (shortcuts=0, coverage=1): all cells reachable", () => {
  const m = generateMaze(opts({ entrances: false }), makeRng(3));
  const seen = new Set();
  const stack = [[0, 0]];
  // Start cell: find the first open cell
  outer: for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if (m.masks[r][c].size) { stack[0] = [r, c]; break outer; }
  }
  while (stack.length) {
    const [r, c] = stack.pop();
    const key = r * m.cols + c;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const d of m.masks[r][c]) {
      const nr = r + (d === S ? 1 : 0) - (d === N ? 1 : 0);
      const nc = c + (d === E ? 1 : 0) - (d === W ? 1 : 0);
      if (nr >= 0 && nr < m.rows && nc >= 0 && nc < m.cols) stack.push([nr, nc]);
    }
  }
  let open = 0;
  for (const row of m.masks) for (const mask of row) if (mask.size) open++;
  assert.equal(seen.size, open);
  assert.equal(open, m.rows * m.cols); // coverage=1: everything carved
});

test("Reproducible: same seed, same maze", () => {
  const a = generateMaze(opts({ shortcuts: 0.3, rooms: 0.4 }), makeRng(7));
  const b = generateMaze(opts({ shortcuts: 0.3, rooms: 0.4 }), makeRng(7));
  assert.deepEqual(
    a.masks.map((row) => row.map((s) => [...s].sort())),
    b.masks.map((row) => row.map((s) => [...s].sort())),
  );
});

test("Presets exist and presetOptions sets values", () => {
  const names = ["labyrinth", "catacombs", "hedge", "palace", "fortress",
    "suburb", "city", "pacman", "starship", "garden", "forbidden"];
  assert.deepEqual(Object.keys(DUNGEON_PRESETS).sort(), [...names].sort());
  const o = presetOptions("catacombs", 30, 20);
  assert.equal(o.coverage, 0.2);
  assert.equal(o.rooms, 1.0);
  assert.equal(o.cols, 30);
});

test("All presets run without error at several sizes", () => {
  for (const name of Object.keys(DUNGEON_PRESETS)) {
    for (const [c, r] of [[10, 10], [21, 13], [30, 20]]) {
      const m = generateMaze(presetOptions(name, c, r), makeRng(5));
      assert.ok(m.rows > 0 && m.cols > 0, name);
    }
  }
});
