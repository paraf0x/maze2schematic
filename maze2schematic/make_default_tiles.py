"""Erzeugt einfache 5x5-Beispiel-Tiles als .litematic-Dateien.

Aufbau pro Tile (5 breit, 4 hoch, 5 tief):
- y=0: Boden aus smooth_stone
- y=1..3: Waende aus stone_bricks, Wege sind Luft

Wege: das innere 3x3-Feld ist immer offen; pro offener Richtung wird der
mittlere 3er-Streifen der jeweiligen Kante geoeffnet. Kanonische
Ausrichtungen siehe classify.py.

Nutzung: python -m maze2schematic.make_default_tiles [tiles-ordner]
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
    """Weg-Layout: zentrales Quadrat `path_width` x `path_width`, pro offener
    Richtung ein Streifen von dort bis zur Kante. Ohne offene Seiten ist das
    Tile komplett massiv (Felsbereiche bei Dungeon-Generierung)."""
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
    """Baut ein Tile: Bodenschicht (y=0) + `wall_height` Schichten Mauer/Luft.

    `floor_under_wall` ist der Bodenblock unter den Mauern (Default: `floor`).
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
        print(f"geschrieben: {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tiles")
