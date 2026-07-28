// 2D-Vorschauen: Maze-Ansicht (Wandlinien) und Top-Down-Ansicht (Blockfarben
// von oben). Reine Zeichenfunktionen ohne eigene DOM-Verdrahtung -- main.js
// ruft `drawMaze`/`drawTopdown` aus den "maze-changed"/"assembly-changed"-
// Listenern auf. Das Modul greift zur Ladezeit nicht auf `document`/`window`
// zu (nur innerhalb der exportierten Funktionen, ueber die uebergebenen
// Canvas-Objekte), damit es in Node importierbar bleibt.

import { N, E, S, W } from "./generate.js";

const WALL_COLOR = "#e6e6e6"; // entspricht --fg aus style.css
const TOPDOWN_BG = "#1b1d22"; // entspricht --bg aus style.css

// Kleine Tabelle fuer gaengige Bloecke -- von preview3d.js (Task 12)
// mitgenutzt, damit Top-Down- und 3D-Ansicht dieselben Farben zeigen.
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

/** Einfacher deterministischer String-Hash (fuer Fallback-Farben). */
function _hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Farbe fuer eine Block-Id: bekannte Bloecke aus `BLOCK_COLORS`, sonst
 * deterministische HSL-Farbe (Hash der Id -> Farbton, feste Saettigung/
 * Helligkeit). `air` wird hier nicht sonderbehandelt (steht bereits in
 * `BLOCK_COLORS`); Aufrufer, die Luft anders behandeln wollen (z.B. gar
 * nicht zeichnen), pruefen das selbst. */
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

/** Synct die Canvas-Pixelgroesse auf die Elterngroesse (CSS-Pixel * DPR) und
 * liefert einen 2D-Kontext, dessen Koordinatensystem bereits in CSS-Pixeln
 * arbeitet (per `setTransform`). Wird einmal pro Draw-Aufruf gerufen. */
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

/** Zeichnet die Maze-Ansicht: fuer jede Zelle wird fuer jede NICHT offene
 * Richtung die entsprechende Kante als Linie gezeichnet (N = obere Kante,
 * E = rechte Kante, S = untere Kante, W = linke Kante). Vollstaendig
 * geschlossene Zellen (`mask.size === 0`) werden zusaetzlich als Flaeche
 * gefuellt. */
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

/** Zeichnet die Top-Down-Ansicht: pro Saeule (x, z) wird von oben (y =
 * sizeY-1 abwaerts) der erste Nicht-Luft-Block gesucht und dessen Farbe als
 * Rechteck gezeichnet. Reine Luft-Saeulen bleiben auf dem Hintergrund
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
