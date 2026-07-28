// Port von maze2schematic/classify.py — Maske (offene Richtungen) -> Tile + Rotation.
import { N, E, S, W } from "./generate.js";

export const CANONICAL_MASKS = {
  closed: [],
  dead_end: [N],
  straight: [N, S],
  turn: [N, E],
  tee: [E, S, W],
  cross: [N, E, S, W],
};

export const TILE_NAMES = Object.keys(CANONICAL_MASKS);

export function rotateMask(dirs, times) {
  return dirs.map((d) => (d + times) % 4);
}

const maskKey = (dirs) => [...dirs].sort().join(",");

const LOOKUP = new Map();
for (const [name, canonical] of Object.entries(CANONICAL_MASKS)) {
  for (let r = 0; r < 4; r++) {
    const key = maskKey(rotateMask(canonical, r));
    if (!LOOKUP.has(key)) LOOKUP.set(key, { name, rotation: r });
  }
}

export function classify(mask) {
  return LOOKUP.get(maskKey(mask));
}
