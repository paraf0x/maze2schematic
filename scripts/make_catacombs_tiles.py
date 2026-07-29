"""Generates a 5x5 "Paris catacombs" tunnel tile set (.litematic).

Look: cramped ossuary tunnels under the city -- weathered stone-brick and
mossy-cobble walls, bone-block stacks in wall niches, a skeleton skull
shrine at dead ends, a shallow water gutter running down the corridor
center and cold soul-lantern light hanging from the ceiling.

Layout per tile (5 wide, 6 high, 5 deep), corridor 3 wide (x/z 1..3):
- y=0 floor: water gutter along the corridor centerline, walkway mix beside
- y=1..4: corridor air / 1-thick walls; inverted stairs at y=4 on the
  corridor sides hint at a vaulted ceiling (center stays 4 high)
- y=5 ceiling: weathered stone mix
- soul lantern hanging at the tile center, straight tiles get a barred
  niche on one wall and a bone-block band on the other, dead ends an
  ossuary wall with a skull shrine and cobwebs

Openings use the middle 3-cell strip of each edge (canonical orientations
per maze2schematic/classify.py; north = -z). Not mix-and-matchable with
the 7x7 sets (tiles_fallout/, tiles_vault/) -- tile sizes differ.

Usage: .venv/bin/python scripts/make_catacombs_tiles.py [tiles-dir]
"""

from __future__ import annotations

import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from litemapy import BlockState, Region

from maze2schematic.classify import CANONICAL_MASKS
from maze2schematic.svg_parser import E, N, S, W

SIZE = 5
HEIGHT = 6
LO, HI = 1, 3  # 3-wide corridor strip
CENTER = 2

AIR = BlockState("minecraft:air")
WATER = BlockState("minecraft:water", level="0")
SOUL_LANTERN = BlockState("minecraft:soul_lantern", hanging="true", waterlogged="false")
SKULL = BlockState("minecraft:skeleton_skull", rotation="8")  # faces north
COBWEB = BlockState("minecraft:cobweb")
IRON_BARS_NS = BlockState(
    "minecraft:iron_bars",
    north="true", south="true", east="false", west="false", waterlogged="false",
)


def bone(axis: str) -> BlockState:
    return BlockState("minecraft:bone_block", axis=axis)


def arch_stair(facing: str) -> BlockState:
    return BlockState(
        "minecraft:stone_brick_stairs",
        facing=facing, half="top", shape="straight", waterlogged="false",
    )


# Weathered mixes: (BlockState, weight)
WALL_MIX = [
    (BlockState("minecraft:stone_bricks"), 5),
    (BlockState("minecraft:mossy_stone_bricks"), 3),
    (BlockState("minecraft:cracked_stone_bricks"), 2),
    (BlockState("minecraft:cobblestone"), 2),
    (BlockState("minecraft:mossy_cobblestone"), 1),
    (BlockState("minecraft:tuff"), 1),
]
FLOOR_MIX = [
    (BlockState("minecraft:stone_bricks"), 4),
    (BlockState("minecraft:cracked_stone_bricks"), 2),
    (BlockState("minecraft:cobblestone"), 2),
    (BlockState("minecraft:mossy_stone_bricks"), 1),
    (BlockState("minecraft:gravel"), 1),
]
CEILING_MIX = [
    (BlockState("minecraft:stone_bricks"), 4),
    (BlockState("minecraft:mossy_stone_bricks"), 2),
    (BlockState("minecraft:cobblestone"), 2),
    (BlockState("minecraft:tuff"), 1),
]


def _pick(rng: random.Random, mix: list[tuple[BlockState, int]]) -> BlockState:
    return rng.choices([b for b, _ in mix], weights=[w for _, w in mix])[0]


def _covers(open_dirs: frozenset[int], axis: str, x: int, z: int) -> bool:
    """Does the N-S ("ns") or E-W ("ew") corridor cover cell (x, z)?"""
    if axis == "ns":
        if not (N in open_dirs or S in open_dirs) or not (LO <= x <= HI):
            return False
        z_lo = 0 if N in open_dirs else LO
        z_hi = SIZE - 1 if S in open_dirs else HI
        return z_lo <= z <= z_hi
    if not (E in open_dirs or W in open_dirs) or not (LO <= z <= HI):
        return False
    x_lo = 0 if W in open_dirs else LO
    x_hi = SIZE - 1 if E in open_dirs else HI
    return x_lo <= x <= x_hi


def _gutter(open_dirs: frozenset[int], x: int, z: int) -> bool:
    """Water gutter along the corridor centerline, only toward open sides
    (it stops at the tile center before closed walls, so e.g. the dead-end
    shrine stays on dry floor)."""
    if x == CENTER and (N in open_dirs or S in open_dirs):
        z_lo = 0 if N in open_dirs else CENTER
        z_hi = SIZE - 1 if S in open_dirs else CENTER
        if z_lo <= z <= z_hi:
            return True
    if z == CENTER and (E in open_dirs or W in open_dirs):
        x_lo = 0 if W in open_dirs else CENTER
        x_hi = SIZE - 1 if E in open_dirs else CENTER
        if x_lo <= x <= x_hi:
            return True
    return x == CENTER and z == CENTER and bool(open_dirs)


def make_tile_region(name: str, open_dirs: frozenset[int]) -> Region:
    rng = random.Random(f"catacombs:{name}")
    region = Region(0, 0, 0, SIZE, HEIGHT, SIZE)

    for x in range(SIZE):
        for z in range(SIZE):
            ns = _covers(open_dirs, "ns", x, z)
            ew = _covers(open_dirs, "ew", x, z)
            path = ns or ew

            # Floor
            if path and _gutter(open_dirs, x, z):
                region[x, 0, z] = WATER
            else:
                region[x, 0, z] = _pick(rng, FLOOR_MIX if path else WALL_MIX)

            # Corridor space / walls (y=1..4)
            for y in range(1, HEIGHT - 1):
                region[x, y, z] = AIR if path else _pick(rng, WALL_MIX)

            # Vault hint: inverted stairs on the corridor sides, only where
            # a single corridor covers the cell (junction cores stay open).
            if path and not (ns and ew):
                if ns and x != CENTER:
                    region[x, 4, z] = arch_stair("east" if x < CENTER else "west")
                elif ew and z != CENTER:
                    region[x, 4, z] = arch_stair("south" if z < CENTER else "north")

            # Ceiling
            region[x, 5, z] = _pick(rng, CEILING_MIX)

    if open_dirs:
        # Cold lantern light hanging above the tile center
        region[CENTER, 4, CENTER] = SOUL_LANTERN

    if open_dirs == frozenset({N, S}):  # canonical straight runs N-S
        # West wall: barred niche at the tile center (backing wall is the
        # neighbor tile's edge). East wall: stacked-bone ossuary band.
        region[0, 2, CENTER] = IRON_BARS_NS
        for z in range(LO, HI + 1):
            for y in (1, 2):
                region[SIZE - 1, y, z] = bone("z")

    if name == "tee":
        # Ossuary band on the closed north wall, facing the junction
        for x in range(LO, HI + 1):
            for y in (1, 2):
                region[x, y, 0] = bone("x")

    if name == "dead_end":
        # Ossuary end wall (opening is north) with a skull shrine in front
        for x in range(LO, HI + 1):
            for y in (1, 2):
                region[x, y, SIZE - 1] = bone("x")
        region[CENTER, 3, SIZE - 1] = bone("x")
        region[CENTER, 1, HI] = SKULL
        region[LO, 3, HI] = COBWEB
        region[HI, 3, HI] = COBWEB

    return region


def main(tiles_dir: str = "tiles_catacombs") -> None:
    os.makedirs(tiles_dir, exist_ok=True)
    for name, mask in CANONICAL_MASKS.items():
        region = make_tile_region(name, mask)
        schem = region.as_schematic(name=f"catacombs_{name}", author="maze2schematic")
        path = os.path.join(tiles_dir, f"{name}.litematic")
        schem.save(path)
        print(f"written: {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tiles_catacombs")
