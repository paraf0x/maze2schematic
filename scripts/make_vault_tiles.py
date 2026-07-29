"""Generates a 7x7 "futuristic vault" tube-tunnel tile set (.litematic).

Look: rounded metro-tube corridors (arched cross-section built from
deepslate stairs), polished-deepslate/deepslate-tile shell, iron-block
ribs, a waxed-copper walkway down the middle, sea-lantern apex lights and
vent grates -- a clean, modern vault feel.

Layout per tile (7 wide, 7 high, 7 deep), corridor 5 wide (x/z 1..5):
- cross-section per lateral distance d from the corridor centerline:
    d=0: air y1..5 (apex)
    d=1: air y1..4, inverted stair y5
    d=2: stair y1 (step), air y2..3, inverted stair y4
- y=0 floor: copper centerline, smooth stone walkway, deepslate under rim
- junction cells covered by two corridors take the taller profile (vaulted)
- sea lantern above each tile center, iron-block ribs along the walls

Openings use the middle 5-cell strip of each edge (canonical orientations
per maze2schematic/classify.py; north = -z). Not mix-and-matchable with
the 3-wide sets (tiles/, presets/, tiles_fallout/) -- openings differ.

Usage: .venv/bin/python scripts/make_vault_tiles.py [tiles-dir]
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
LO, HI = 1, 5  # 5-wide corridor strip
CENTER = 3

AIR = BlockState("minecraft:air")
SEA_LANTERN = BlockState("minecraft:sea_lantern")
IRON = BlockState("minecraft:iron_block")
COPPER = BlockState("minecraft:waxed_cut_copper")
WALKWAY = BlockState("minecraft:smooth_stone")
RIM_FLOOR = BlockState("minecraft:polished_deepslate")


def stair(facing: str, half: str) -> BlockState:
    return BlockState(
        "minecraft:polished_deepslate_stairs",
        facing=facing, half=half, shape="straight", waterlogged="false",
    )


def bars(axis: str) -> BlockState:
    ns = "true" if axis == "ns" else "false"
    ew = "true" if axis == "ew" else "false"
    return BlockState(
        "minecraft:iron_bars",
        north=ns, south=ns, east=ew, west=ew, waterlogged="false",
    )


SHELL_MIX = [
    (BlockState("minecraft:polished_deepslate"), 6),
    (BlockState("minecraft:deepslate_tiles"), 3),
    (BlockState("minecraft:cracked_deepslate_tiles"), 1),
]

# Cross-section profile per |d| from the corridor centerline:
# (air_lo, air_hi, bottom_stair_y, top_stair_y)
PROFILE = {0: (1, 5, None, None), 1: (1, 4, None, 5), 2: (2, 3, 1, 4)}


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


def make_tile_region(name: str, open_dirs: frozenset[int]) -> Region:
    rng = random.Random(f"vault:{name}")
    region = Region(0, 0, 0, SIZE, HEIGHT, SIZE)

    for x in range(SIZE):
        for z in range(SIZE):
            ns = _covers(open_dirs, "ns", x, z)
            ew = _covers(open_dirs, "ew", x, z)

            # Column plan: start fully solid, then carve the tube profile(s).
            column: dict[int, BlockState] = {
                y: _pick(rng, SHELL_MIX) for y in range(HEIGHT)
            }

            profiles = []
            if ns:
                profiles.append(("ns", abs(x - CENTER)))
            if ew:
                profiles.append(("ew", abs(z - CENTER)))

            if profiles:
                air_lo = min(PROFILE[d][0] for _, d in profiles)
                air_hi = max(PROFILE[d][1] for _, d in profiles)
                for y in range(air_lo, air_hi + 1):
                    column[y] = AIR

                # Rounding stairs only where a single corridor covers the
                # cell -- junction cores stay plainly vaulted.
                if len(profiles) == 1:
                    axis, d = profiles[0]
                    lateral = x if axis == "ns" else z
                    inward = (
                        ("east" if lateral < CENTER else "west")
                        if axis == "ns"
                        else ("south" if lateral < CENTER else "north")
                    )
                    _, _, bottom_y, top_y = PROFILE[d]
                    if bottom_y is not None:
                        column[bottom_y] = stair(inward, "bottom")
                    if top_y is not None:
                        column[top_y] = stair(inward, "top")

                # Floor finish
                on_ns_line = ns and x == CENTER
                on_ew_line = ew and z == CENTER
                min_d = min(d for _, d in profiles)
                if on_ns_line or on_ew_line:
                    column[0] = COPPER
                elif min_d <= 1:
                    column[0] = WALKWAY
                else:
                    column[0] = RIM_FLOOR

            for y in range(HEIGHT):
                region[x, y, z] = column[y]

    if open_dirs:
        # Apex light above the tile center
        region[CENTER, 6, CENTER] = SEA_LANTERN

        # Iron ribs: columns in the side walls flanking each corridor
        for pos in (1, 5):
            if N in open_dirs or S in open_dirs:
                for wall_x in (0, SIZE - 1):
                    if not _covers(open_dirs, "ew", wall_x, pos):
                        for y in range(1, 5):
                            region[wall_x, y, pos] = IRON
            if E in open_dirs or W in open_dirs:
                for wall_z in (0, SIZE - 1):
                    if not _covers(open_dirs, "ns", pos, wall_z):
                        for y in range(1, 5):
                            region[pos, y, wall_z] = IRON

    # Vent grates: flush iron bars in the side walls of straight corridors
    if open_dirs == frozenset({N, S}):  # canonical straight runs N-S
        for wall_x in (0, SIZE - 1):
            for y in (2, 3):
                region[wall_x, y, CENTER] = bars("ns")

    if name == "dead_end":
        # Sealed vault-door hint on the south end wall (opening is north)
        for x in range(2, 5):
            for y in range(1, 5):
                region[x, y, SIZE - 1] = IRON
        for y in (2, 3):
            region[CENTER, y, SIZE - 1] = bars("ew")

    return region


def main(tiles_dir: str = "tiles_vault") -> None:
    os.makedirs(tiles_dir, exist_ok=True)
    for name, mask in CANONICAL_MASKS.items():
        region = make_tile_region(name, mask)
        schem = region.as_schematic(name=f"vault_{name}", author="maze2schematic")
        path = os.path.join(tiles_dir, f"{name}.litematic")
        schem.save(path)
        print(f"written: {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tiles_vault")
