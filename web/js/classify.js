// Port of maze2schematic/classify.py — mask (open directions) -> tile + rotation.
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

/** Canonical (never rotated) entrance/exit arrow specs for a tile type,
 * used by the tile manager thumbnails (preview2d.js/preview3d.js) to show
 * where a tile's openings are *expected* to be -- independent of the
 * tile's actual geometry/rotation, so the user can compare "expected" vs.
 * "actual" and hit the rotate button if they don't line up.
 *
 * Rule: the first direction in `CANONICAL_MASKS[typeName]` is the
 * entrance (kind "in", drawn pointing into the tile); every other
 * direction is an exit (kind "out", drawn pointing out of the tile).
 * `closed` (or an unknown type name) has no openings, so it yields `[]`. */
export function arrowSpecs(typeName) {
  const mask = CANONICAL_MASKS[typeName];
  if (!mask || mask.length === 0) return [];
  return mask.map((dir, i) => ({ dir, kind: i === 0 ? "in" : "out" }));
}
