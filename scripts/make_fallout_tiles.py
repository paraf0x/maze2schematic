"""Generates a 7x7 "fallout metro" tunnel tile set as .litematic files.

Look: weathered stone-brick/tuff tunnels with andesite pilasters, spruce
ceiling beams, a chiseled center floor strip, barred wall niches and warm
glowstone ceiling lights -- inspired by vault/metro builds.

Layout per tile (7 wide, 7 high, 7 deep):
- y=0: floor (mixed weathered stone, chiseled center strip along corridors)
- y=1..5: walls / open corridor, pilaster columns on the inner wall ring
- y=5: spruce beams across corridors at the tile center
- y=6: ceiling (mixed stone, glowstone light above the center)

Openings use the middle 3-cell strip of each edge (canonical orientations
per maze2schematic/classify.py; north = -z).

Usage: .venv/bin/python scripts/make_fallout_tiles.py [tiles-dir]
"""

from __future__ import annotations

import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from litemapy import BlockState, Region

from maze2schematic.classify import CANONICAL_MASKS
from maze2schematic.svg_parser import E, N, S, W

SIZE = 7
HEIGHT = 7
LO, HI = 2, 4  # middle 3-cell corridor strip

AIR = BlockState("minecraft:air")
GLOWSTONE = BlockState("minecraft:glowstone")
BEAM = BlockState("minecraft:spruce_planks")
PILASTER = BlockState("minecraft:polished_andesite")
CENTER_STRIP = BlockState("minecraft:chiseled_stone_bricks")
IRON_BARS_NS = BlockState(
    "minecraft:iron_bars",
    north="true", south="true", east="false", west="false", waterlogged="false",
)
IRON_BARS_EW = BlockState(
    "minecraft:iron_bars",
    north="false", south="false", east="true", west="true", waterlogged="false",
)

# Weathered mixes: (BlockState, weight)
WALL_MIX = [
    (BlockState("minecraft:stone_bricks"), 5),
    (BlockState("minecraft:cracked_stone_bricks"), 2),
    (BlockState("minecraft:tuff"), 3),
    (BlockState("minecraft:andesite"), 2),
    (BlockState("minecraft:mossy_stone_bricks"), 1),
]
FLOOR_MIX = [
    (BlockState("minecraft:stone_bricks"), 4),
    (BlockState("minecraft:andesite"), 3),
    (BlockState("minecraft:cracked_stone_bricks"), 2),
    (BlockState("minecraft:gravel"), 1),
]
CEILING_MIX = [
    (BlockState("minecraft:stone_bricks"), 4),
    (BlockState("minecraft:tuff"), 3),
    (BlockState("minecraft:andesite"), 2),
]


def _pick(rng: random.Random, mix: list[tuple[BlockState, int]]) -> BlockState:
    return rng.choices([b for b, _ in mix], weights=[w for _, w in mix])[0]


def _is_path(x: int, z: int, open_dirs: frozenset[int]) -> bool:
    if not open_dirs:
        return False
    in_x, in_z = LO <= x <= HI, LO <= z <= HI
    if in_x and in_z:
        return True
    if in_x and z < LO:
        return N in open_dirs
    if in_z and x > HI:
        return E in open_dirs
    if in_x and z > HI:
        return S in open_dirs
    if in_z and x < LO:
        return W in open_dirs
    return False


def _center_strip(x: int, z: int, open_dirs: frozenset[int]) -> bool:
    """Chiseled floor line along the middle of each corridor."""
    if x == 3 and (N in open_dirs or S in open_dirs) and _is_path(x, z, open_dirs):
        return True
    if z == 3 and (E in open_dirs or W in open_dirs) and _is_path(x, z, open_dirs):
        return True
    return x == 3 and z == 3 and bool(open_dirs)


def _beam(x: int, z: int, open_dirs: frozenset[int]) -> bool:
    """Spruce beam across each corridor at the tile center (y=5)."""
    if z == 3 and LO <= x <= HI and (N in open_dirs or S in open_dirs):
        return True
    if x == 3 and LO <= z <= HI and (E in open_dirs or W in open_dirs):
        return True
    return False


def make_tile_region(name: str, open_dirs: frozenset[int]) -> Region:
    rng = random.Random(f"fallout:{name}")
    region = Region(0, 0, 0, SIZE, HEIGHT, SIZE)

    for x in range(SIZE):
        for z in range(SIZE):
            path = _is_path(x, z, open_dirs)

            # Floor
            if path and _center_strip(x, z, open_dirs):
                region[x, 0, z] = CENTER_STRIP
            else:
                region[x, 0, z] = _pick(rng, FLOOR_MIX if path else WALL_MIX)

            # Walls / corridor space (y=1..5)
            pilaster = (not path) and x in (1, 5) and z in (1, 5)
            for y in range(1, HEIGHT - 1):
                if path:
                    region[x, y, z] = BEAM if y == 5 and _beam(x, z, open_dirs) else AIR
                elif pilaster:
                    region[x, y, z] = PILASTER
                else:
                    region[x, y, z] = _pick(rng, WALL_MIX)

            # Ceiling
            if path and x == 3 and z == 3:
                region[x, 6, z] = GLOWSTONE
            else:
                region[x, 6, z] = _pick(rng, CEILING_MIX)

    # Barred niches on straight corridors: carve the inner wall layer at the
    # tile center and gate it with iron bars (backing wall stays intact).
    if open_dirs == frozenset({N, S}):  # canonical straight: corridor runs N-S
        for x in (1, 5):
            for y in (2, 3):
                region[x, y, 3] = IRON_BARS_NS
    if name == "dead_end":
        # Gated recess at the dead end (south wall, since the opening is north)
        for y in (2, 3):
            region[3, y, 5] = IRON_BARS_EW

    return region


def main(tiles_dir: str = "tiles_fallout") -> None:
    os.makedirs(tiles_dir, exist_ok=True)
    for name, mask in CANONICAL_MASKS.items():
        region = make_tile_region(name, mask)
        schem = region.as_schematic(name=f"fallout_{name}", author="maze2schematic")
        path = os.path.join(tiles_dir, f"{name}.litematic")
        schem.save(path)
        print(f"written: {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tiles_fallout")
