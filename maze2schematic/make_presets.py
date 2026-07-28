"""Generates the presets/ folder structure with one subfolder per tile type.

Structure:
    presets/
      variants.json               (variant weights)
      straight/straight.litematic
      straight/straight_slim.litematic
      turn/...
      tcross/...
      xcross/...
      deadend/...
      closed/...

Tile layout (5x5 footprint, height 3):
- Standard: path 3 blocks wide, wall 1 block thick
- Slim:     path 1 block wide, wall 2 blocks thick
- Path floor of coarse_dirt, walls 2 blocks high of stone_bricks
  (floor under the wall is also stone_bricks)

Canonical orientations (see classify.py): deadend open to the north,
straight north-south, turn north+east, tcross closed to the north,
xcross all open.

Usage: python -m maze2schematic.make_presets [presets-dir]
"""

from __future__ import annotations

import json
import os
import sys

from litemapy import BlockState

from .classify import CANONICAL_MASKS
from .make_default_tiles import make_tile_region

# Preset folder name -> canonical tile name
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

# Variant -> path width
VARIANTS = {"": 3, "_slim": 1}

# Default config for variants.json
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
            print(f"written: {path}")

    config_path = os.path.join(presets_dir, "variants.json")
    if os.path.exists(config_path):
        print(f"unchanged (already exists): {config_path}")
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
        print(f"written: {config_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "presets")
