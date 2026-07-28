// 2D previews: maze view (wall lines) and top-down view (block colors seen
// from above). Pure drawing functions with no DOM wiring of their own --
// main.js calls `drawMaze`/`drawTopdown` from the "maze-changed"/
// "assembly-changed" listeners. The module doesn't touch `document`/`window`
// at load time (only inside the exported functions, via the passed-in
// canvas objects), keeping it importable in Node.

import { N, E, S, W } from "./generate.js";

const WALL_COLOR = "#e6e6e6"; // matches --fg in style.css
const TOPDOWN_BG = "#1b1d22"; // matches --bg in style.css

// Small table for common blocks -- shared with preview3d.js (task 12) so
// the top-down and 3D views use the same colors.
export const BLOCK_COLORS = {
  "minecraft:air": TOPDOWN_BG,
  "minecraft:stone": "#8a8a8a",
  "minecraft:cobblestone": "#7a7a7a",
  "minecraft:mossy_cobblestone": "#6f7a5e",
  "minecraft:stone_bricks": "#8f8f8f",
  "minecraft:mossy_stone_bricks": "#7c8770",
  "minecraft:cracked_stone_bricks": "#828282",
  "minecraft:andesite": "#8b8c8c",
  "minecraft:gravel": "#8d8681",
  "minecraft:oak_planks": "#b1875a",
  "minecraft:oak_log": "#6b4a2b",
  "minecraft:oak_stairs": "#b1875a",
  "minecraft:oak_slab": "#b1875a",
  "minecraft:oak_fence": "#8a6239",
  "minecraft:oak_door": "#a17b4a",
  "minecraft:spruce_planks": "#7a5a37",
  "minecraft:spruce_log": "#4a3620",
  "minecraft:spruce_stairs": "#7a5a37",
  "minecraft:spruce_slab": "#7a5a37",
  "minecraft:spruce_fence": "#5c4326",
  "minecraft:oak_leaves": "#4c7a3a",
  "minecraft:spruce_leaves": "#3c6b3a",
  "minecraft:grass_block": "#5a9c3f",
  "minecraft:dirt": "#6b4a2b",
  "minecraft:water": "#3a6fd8",
  "minecraft:glass": "#bfe3e8",
  "minecraft:torch": "#e8b23a",
  "minecraft:wall_torch": "#e8b23a",
};

/** Simple deterministic string hash (for fallback colors). */
function _hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Color for a block id: known blocks from `BLOCK_COLORS`, otherwise a
 * deterministic HSL color (hash of the id -> hue, fixed saturation/
 * lightness). `air` is not special-cased here (it's already in
 * `BLOCK_COLORS`); callers that want to treat air differently (e.g. not
 * draw it at all) check for it themselves. */
export function colorForBlock(id) {
  if (Object.prototype.hasOwnProperty.call(BLOCK_COLORS, id)) {
    return BLOCK_COLORS[id];
  }
  const hue = _hashString(id) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function _devicePixelRatio() {
  if (typeof devicePixelRatio !== "undefined" && devicePixelRatio) return devicePixelRatio;
  if (typeof window !== "undefined" && window.devicePixelRatio) return window.devicePixelRatio;
  return 1;
}

/** Syncs the canvas pixel size to the parent size (CSS pixels * DPR) and
 * returns a 2D context whose coordinate system already works in CSS
 * pixels (via `setTransform`). Called once per draw call. */
function _syncCanvas(canvas) {
  const dpr = _devicePixelRatio();
  const cssWidth = canvas.clientWidth || canvas.width || 0;
  const cssHeight = canvas.clientHeight || canvas.height || 0;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssWidth, cssHeight };
}

/** Draws the maze view: for each cell, the corresponding edge is drawn as
 * a line for every direction that is NOT open (N = top edge, E = right
 * edge, S = bottom edge, W = left edge). Fully closed cells
 * (`mask.size === 0`) are additionally filled as a solid area. */
export function drawMaze(canvas, maze) {
  const { ctx, cssWidth, cssHeight } = _syncCanvas(canvas);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!maze || maze.rows <= 0 || maze.cols <= 0) return;

  const s = Math.floor(Math.min(cssWidth / maze.cols, cssHeight / maze.rows));
  if (s <= 0) return;

  ctx.fillStyle = WALL_COLOR;
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      if (maze.masks[r][c].size === 0) {
        ctx.fillRect(c * s, r * s, s, s);
      }
    }
  }

  ctx.strokeStyle = WALL_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      const mask = maze.masks[r][c];
      const x0 = c * s, y0 = r * s, x1 = x0 + s, y1 = y0 + s;
      if (!mask.has(N)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
      if (!mask.has(E)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
      if (!mask.has(S)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
      if (!mask.has(W)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
    }
  }
  ctx.stroke();
}

/** Draws the top-down view: for each column (x, z), the first non-air
 * block is found from the top (y = sizeY-1 downward) and its color is
 * drawn as a rectangle. Columns that are all air stay on the background
 * (`TOPDOWN_BG`). */
export function drawTopdown(canvas, assembly) {
  const { ctx, cssWidth, cssHeight } = _syncCanvas(canvas);
  ctx.fillStyle = TOPDOWN_BG;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  if (!assembly || assembly.sizeX <= 0 || assembly.sizeZ <= 0) return;

  const { sizeX, sizeY, sizeZ, palette, blocks } = assembly;
  const px = Math.floor(Math.min(cssWidth / sizeX, cssHeight / sizeZ));
  if (px <= 0) return;

  for (let x = 0; x < sizeX; x++) {
    for (let z = 0; z < sizeZ; z++) {
      let color = null;
      for (let y = sizeY - 1; y >= 0; y--) {
        const idx = blocks[(y * sizeZ + z) * sizeX + x];
        const state = palette[idx];
        if (state && state.id !== "minecraft:air") {
          color = colorForBlock(state.id);
          break;
        }
      }
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x * px, z * px, px, px);
      }
    }
  }
}
