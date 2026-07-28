"""Erzeugt die presets/-Ordnerstruktur mit einem Unterordner pro Tile-Art.

Struktur:
    presets/
      variants.json               (Gewichte der Varianten)
      straight/straight.litematic
      straight/straight_slim.litematic
      turn/...
      tcross/...
      xcross/...
      deadend/...
      closed/...

Tile-Aufbau (5x5 Grundflaeche, Hoehe 3):
- Standard: Weg 3 Bloecke breit, Mauer 1 Block dick
- Slim:     Weg 1 Block breit, Mauer 2 Bloecke dick
- Weg-Boden aus coarse_dirt, Mauern 2 Bloecke hoch aus stone_bricks
  (Boden unter der Mauer ebenfalls stone_bricks)

Kanonische Ausrichtungen (siehe classify.py): deadend offen nach Norden,
straight Nord-Sued, turn Nord+Ost, tcross zu nach Norden, xcross alle offen.

Nutzung: python -m maze2schematic.make_presets [presets-ordner]
"""

from __future__ import annotations

import json
import os
import sys

from litemapy import BlockState

from .classify import CANONICAL_MASKS
from .make_default_tiles import make_tile_region

# Preset-Ordnername -> kanonischer Tile-Name
PRESET_NAMES = {
    "straight": "straight",
    "turn": "turn",
    "tcross": "tee",
    "xcross": "cross",
    "deadend": "dead_end",
    "closed": "closed",
}

PATH_FLOOR = BlockState("minecraft:coarse_dirt")
WALL = BlockState("minecraft:stone_bricks")
WALL_HEIGHT = 2

# Variante -> Wegbreite
VARIANTS = {"": 3, "_slim": 1}

# Default-Config fuer variants.json
DEFAULT_WEIGHTS = {"": 3, "_slim": 1}
DEFAULT_CLUSTERS = {"slim": {"min": 3, "max": 8}}


def main(presets_dir: str = "presets") -> None:
    for preset_name, canonical in PRESET_NAMES.items():
        subdir = os.path.join(presets_dir, preset_name)
        os.makedirs(subdir, exist_ok=True)
        for suffix, path_width in VARIANTS.items():
            region = make_tile_region(
                CANONICAL_MASKS[canonical],
                floor=PATH_FLOOR,
                wall=WALL,
                wall_height=WALL_HEIGHT,
                floor_under_wall=WALL,
                path_width=path_width,
            )
            variant = f"{preset_name}{suffix}"
            schem = region.as_schematic(name=variant, author="maze2schematic")
            path = os.path.join(subdir, f"{variant}.litematic")
            schem.save(path)
            print(f"geschrieben: {path}")

    config_path = os.path.join(presets_dir, "variants.json")
    if os.path.exists(config_path):
        print(f"unveraendert (existiert schon): {config_path}")
    else:
        config = {
            "weights": {
                f"{preset}{suffix}": weight
                for preset in PRESET_NAMES
                for suffix, weight in DEFAULT_WEIGHTS.items()
            },
            "clusters": DEFAULT_CLUSTERS,
        }
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
            f.write("\n")
        print(f"geschrieben: {config_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "presets")
