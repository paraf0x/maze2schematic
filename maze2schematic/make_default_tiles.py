"""Generates simple 5x5 sample tiles as .litematic files.

Layout per tile (5 wide, 4 high, 5 deep):
- y=0: floor of smooth_stone
- y=1..3: walls of stone_bricks, paths are air

Paths: the inner 3x3 area is always open; for each open direction the
middle 3-cell strip of that edge is opened. See classify.py for the
canonical orientations.

Usage: python -m maze2schematic.make_default_tiles [tiles-dir]
"""

from __future__ import annotations

import os
import sys

from litemapy import BlockState, Region

from .classify import CANONICAL_MASKS
from .svg_parser import E, N, S, W

SIZE = 5

FLOOR = BlockState("minecraft:smooth_stone")
WALL = BlockState("minecraft:stone_bricks")
AIR = BlockState("minecraft:air")


def _is_path(x: int, z: int, open_dirs: frozenset[int], path_width: int = 3) -> bool:
    """Path layout: a central `path_width` x `path_width` square, with a
    strip from there to the edge for each open direction. With no open
    sides the tile is fully solid (solid areas in dungeon generation)."""
    if not open_dirs:
        return False
    lo = (SIZE - path_width) // 2
    hi = lo + path_width - 1
    in_strip_x = lo <= x <= hi
    in_strip_z = lo <= z <= hi
    if in_strip_x and in_strip_z:
        return True
    if in_strip_x and z < lo:
        return N in open_dirs
    if in_strip_z and x > hi:
        return E in open_dirs
    if in_strip_x and z > hi:
        return S in open_dirs
    if in_strip_z and x < lo:
        return W in open_dirs
    return False


def make_tile_region(
    open_dirs: frozenset[int],
    floor: BlockState = FLOOR,
    wall: BlockState = WALL,
    wall_height: int = 3,
    floor_under_wall: BlockState | None = None,
    path_width: int = 3,
) -> Region:
    """Builds a tile: floor layer (y=0) + `wall_height` layers of wall/air.

    `floor_under_wall` is the floor block under the walls (default: `floor`).
    """
    region = Region(0, 0, 0, SIZE, 1 + wall_height, SIZE)
    for x in range(SIZE):
        for z in range(SIZE):
            path = _is_path(x, z, open_dirs, path_width)
            region[x, 0, z] = floor if path or floor_under_wall is None else floor_under_wall
            for y in range(1, 1 + wall_height):
                region[x, y, z] = AIR if path else wall
    return region


def main(tiles_dir: str = "tiles") -> None:
    os.makedirs(tiles_dir, exist_ok=True)
    for name, mask in CANONICAL_MASKS.items():
        region = make_tile_region(mask)
        schem = region.as_schematic(name=name, author="maze2schematic")
        path = os.path.join(tiles_dir, f"{name}.litematic")
        schem.save(path)
        print(f"written: {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tiles")
