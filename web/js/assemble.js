// Assembles the complete schematic from Maze + TileSet. Port of
// maze2schematic/assemble.py, without the bias-map parts (load_bias_map is
// dropped, bias parameters are dropped with no replacement).
//
// Style assignment: non-default styles (e.g. "slim") are distributed as
// connected clusters along the corridor graph, with configurable min/max
// size (variants.json -> "clusters"). The area share per style follows
// the weights.

import { classify } from "./classify.js";
import { N, E, S, W } from "./generate.js";
import { DEFAULT_STYLE } from "./tiles.js";
import { AIR, stateKey } from "./litematic.js";

function _neighbors(maze, r, c) {
  const out = [];
  for (const d of maze.masks[r][c]) {
    const nr = r + (d === S ? 1 : 0) - (d === N ? 1 : 0);
    const nc = c + (d === E ? 1 : 0) - (d === W ? 1 : 0);
    if (nr >= 0 && nr < maze.rows && nc >= 0 && nc < maze.cols) {
      out.push([nr, nc]);
    }
  }
  return out;
}

/** Cell is free and (via corridors) does not border the same style --
 * otherwise separately grown clusters would merge into one larger
 * cluster. */
function _freeFor(maze, grid, cell, style) {
  const [r, c] = cell;
  if (grid[r][c] !== null) return false;
  return _neighbors(maze, r, c).every(([nr, nc]) => grid[nr][nc] !== style);
}

/** Grows a cluster from the seed along the corridors into free cells
 * until `size` is reached or nothing is free anymore. */
function _growCluster(maze, grid, seed, size, style, rng) {
  const cluster = new Set([seed.join(",")]);
  const clusterCells = [seed];
  const frontier = [seed];
  while (frontier.length && clusterCells.length < size) {
    const index = rng.randRange(frontier.length);
    const cell = frontier.splice(index, 1)[0];
    for (const nb of _neighbors(maze, cell[0], cell[1])) {
      if (clusterCells.length >= size) break;
      const key = nb.join(",");
      if (!cluster.has(key) && _freeFor(maze, grid, nb, style)) {
        cluster.add(key);
        clusterCells.push(nb);
        frontier.push(nb);
      }
    }
  }
  return clusterCells;
}

/** Assigns a style to every cell.
 *
 * For each non-default style the target share is computed from the
 * weights and placed in connected clusters (min/max cells). Without a
 * cluster config, min = max = 1 (single cells) applies. */
export function assignStyles(maze, tileset, rng) {
  const grid = Array.from({ length: maze.rows }, () => new Array(maze.cols).fill(null));
  const weights = tileset.styleWeights();
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const totalCells = maze.rows * maze.cols;

  for (const [style, weight] of Object.entries(weights)) {
    if (style === DEFAULT_STYLE) continue;
    const target = Math.round((totalCells * weight) / totalWeight);
    const cfg = tileset.clusters[style] ?? { minSize: 1, maxSize: 1 };
    const cmin = cfg.minSize;
    const cmax = cfg.maxSize;
    let placed = 0;
    let attempts = 0;
    const maxAttempts = totalCells * 10;
    while (placed + cmin <= target && attempts < maxAttempts) {
      attempts += 1;
      const seed = [rng.randRange(maze.rows), rng.randRange(maze.cols)];
      if (!_freeFor(maze, grid, seed, style)) continue;
      const size = rng.randIntRange(cmin, Math.min(cmax, target - placed));
      const cluster = _growCluster(maze, grid, seed, size, style, rng);
      if (cluster.length < cmin) continue; // wedged between occupied cells: discard
      for (const [r, c] of cluster) grid[r][c] = style;
      placed += cluster.length;
    }
  }

  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      if (grid[r][c] === null) grid[r][c] = DEFAULT_STYLE;
    }
  }
  return grid;
}

/** Assembles a block grid from Maze + TileSet, in the format that
 * writeLitematic (litematic.js) consumes. */
export function assembleBlocks(maze, tileset, rng, styles = null) {
  if (styles === null) {
    styles = assignStyles(maze, tileset, rng);
  }
  const ts = tileset.size;
  const sizeX = maze.cols * ts;
  const sizeY = tileset.height;
  const sizeZ = maze.rows * ts;

  const palette = [AIR];
  const indexByKey = new Map([[stateKey(AIR), 0]]);
  const blocks = new Uint32Array(sizeX * sizeY * sizeZ);

  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      const { name: tileName, rotation } = classify(maze.masks[row][col]);
      const tile = tileset.get(tileName, rotation, styles[row][col]);
      const ox = col * ts;
      const oz = row * ts;
      for (let x = 0; x < ts; x++) {
        for (let y = 0; y < tileset.height; y++) {
          for (let z = 0; z < ts; z++) {
            const state = tile.blocks[x][y][z];
            const key = stateKey(state);
            let idx = indexByKey.get(key);
            if (idx === undefined) {
              idx = palette.length;
              indexByKey.set(key, idx);
              palette.push(state);
            }
            const bx = ox + x;
            const bz = oz + z;
            blocks[(y * sizeZ + bz) * sizeX + bx] = idx;
          }
        }
      }
    }
  }

  return { sizeX, sizeY, sizeZ, palette, blocks };
}

/** Counts tile types (ignoring style) across the whole maze. */
export function tileStats(maze) {
  const counts = {};
  for (const row of maze.masks) {
    for (const mask of row) {
      const name = classify(mask).name;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}
