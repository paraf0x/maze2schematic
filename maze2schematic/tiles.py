"""Loads tile schematics (.litematic) and rotates them in 90-degree steps.

A tile is held as a 3D array of BlockStates, indexed [x][y][z]
(Minecraft axes: x = east, y = up, z = south). North is -z; SVG row 0
sits at z = 0 in the finished schematic.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass

from litemapy import BlockState, Schematic

from .classify import CANONICAL_MASKS

# facing values clockwise
_FACING_CW = {"north": "east", "east": "south", "south": "west", "west": "north"}
_AXIS_CW = {"x": "z", "z": "x"}
# Connection properties (fences, glass panes, walls, redstone, vines, ...)
_SIDE_PROPS = ("north", "east", "south", "west")
_RAIL_SHAPE_CW = {
    "north_south": "east_west",
    "east_west": "north_south",
    "ascending_north": "ascending_east",
    "ascending_east": "ascending_south",
    "ascending_south": "ascending_west",
    "ascending_west": "ascending_north",
    "north_east": "south_east",
    "south_east": "south_west",
    "south_west": "north_west",
    "north_west": "north_east",
}


def rotate_state_cw(state: BlockState) -> BlockState:
    """Rotates a BlockState by 90 degrees clockwise (viewed from above)."""
    props = dict(state.properties())
    if not props:
        return state
    new_props: dict[str, str] = dict(props)

    if "facing" in props and props["facing"] in _FACING_CW:
        new_props["facing"] = _FACING_CW[props["facing"]]
    if "axis" in props and props["axis"] in _AXIS_CW:
        new_props["axis"] = _AXIS_CW[props["axis"]]
    if "rotation" in props:
        try:
            new_props["rotation"] = str((int(props["rotation"]) + 4) % 16)
        except ValueError:
            pass
    if "shape" in props and props["shape"] in _RAIL_SHAPE_CW:
        new_props["shape"] = _RAIL_SHAPE_CW[props["shape"]]
    if all(p in props for p in _SIDE_PROPS):
        for src, dst in zip(_SIDE_PROPS, ("east", "south", "west", "north")):
            new_props[dst] = props[src]

    return BlockState(state.id, **new_props)


@dataclass
class Tile:
    name: str
    size: int  # footprint size x size
    height: int
    # blocks[x][y][z]
    blocks: list[list[list[BlockState]]]

    def rotated_cw(self) -> "Tile":
        s = self.size
        new_blocks = [
            [[None] * s for _ in range(self.height)] for _ in range(s)
        ]
        for x in range(s):
            for y in range(self.height):
                for z in range(s):
                    # (x, z) -> (s-1-z, x): north edge moves to the east edge
                    new_blocks[s - 1 - z][y][x] = rotate_state_cw(self.blocks[x][y][z])
        return Tile(self.name, s, self.height, new_blocks)


class TileLoadError(Exception):
    pass


def _load_tile(path: str, name: str) -> Tile:
    schem = Schematic.load(path)
    regions = list(schem.regions.values())
    if len(regions) != 1:
        raise TileLoadError(f"{path}: expected exactly 1 region, found {len(regions)}.")
    region = regions[0]
    if region.tile_entities:
        print(
            f"Warning: {path} contains {len(region.tile_entities)} tile entities "
            "(chests, signs, ...); these are ignored.",
            file=sys.stderr,
        )

    sx = abs(region.width)
    sy = abs(region.height)
    sz = abs(region.length)
    if sx != sz:
        raise TileLoadError(f"{path}: footprint must be square, is {sx}x{sz}.")

    xs = sorted(region.range_x())
    ys = sorted(region.range_y())
    zs = sorted(region.range_z())
    blocks = [
        [[region[x, y, z] for z in zs] for y in ys] for x in xs
    ]
    return Tile(name=name, size=sx, height=sy, blocks=blocks)


# Alternate filenames per canonical tile name (presets/ structure)
_ALIASES = {
    "dead_end": ("dead_end", "deadend"),
    "straight": ("straight",),
    "turn": ("turn",),
    "tee": ("tee", "tcross"),
    "cross": ("cross", "xcross"),
    "closed": ("closed",),
}


DEFAULT_STYLE = ""


def _find_tile_files(tiles_dir: str, canonical: str) -> tuple[str, list[str]]:
    """Finds the file(s) for a tile type; returns (alias, paths).

    Supports two layouts:
    - flat:      <dir>/<name>.litematic (one variant)
    - subfolder: <dir>/<name>/*.litematic (each file is a variant)
    """
    for alias in _ALIASES[canonical]:
        flat = os.path.join(tiles_dir, f"{alias}.litematic")
        if os.path.isfile(flat):
            return alias, [flat]
        subdir = os.path.join(tiles_dir, alias)
        if os.path.isdir(subdir):
            files = sorted(f for f in os.listdir(subdir) if f.endswith(".litematic"))
            if files:
                return alias, [os.path.join(subdir, f) for f in files]
    return canonical, []


def _style_of(stem: str, alias: str) -> str:
    """Style of a variant derived from the filename: '<alias>' -> default
    style, '<alias>_<style>' -> '<style>', otherwise the full filename."""
    if stem == alias:
        return DEFAULT_STYLE
    if stem.startswith(alias + "_"):
        return stem[len(alias) + 1 :]
    return stem


@dataclass
class ClusterConfig:
    min_size: int = 1
    max_size: int = 1
    # Path to a bias map (text grid, one digit per cell), optional
    map_path: str | None = None


def _load_config(tiles_dir: str) -> tuple[dict[str, float], dict[str, ClusterConfig]]:
    """Loads variants.json: (weights per file stem, cluster config per style).

    New format:
        {"weights": {"straight_slim": 1, ...},
         "clusters": {"slim": {"min": 3, "max": 8, "map": "slim_map.txt"}}}
    Old format (weights only, flat) is still accepted.

    Variants not listed get weight 1, weight 0 excludes a variant.
    "map" is relative to the tiles folder.
    """
    path = os.path.join(tiles_dir, "variants.json")
    if not os.path.isfile(path):
        return {}, {}
    with open(path) as f:
        data = json.load(f)

    if set(data) <= {"weights", "clusters"}:
        raw_weights = data.get("weights", {})
        raw_clusters = data.get("clusters", {})
    else:
        raw_weights, raw_clusters = data, {}

    weights = {}
    for stem, weight in raw_weights.items():
        if not isinstance(weight, (int, float)) or weight < 0:
            raise TileLoadError(f"variants.json: invalid weight for '{stem}': {weight!r}")
        weights[stem] = float(weight)

    clusters = {}
    for style, cfg in raw_clusters.items():
        cmin, cmax = int(cfg.get("min", 1)), int(cfg.get("max", 1))
        if not 1 <= cmin <= cmax:
            raise TileLoadError(f"variants.json: invalid cluster sizes for '{style}': {cfg!r}")
        map_path = cfg.get("map")
        if map_path is not None:
            map_path = os.path.join(tiles_dir, map_path)
            if not os.path.isfile(map_path):
                raise TileLoadError(f"variants.json: bias map not found: {map_path}")
        clusters[style] = ClusterConfig(cmin, cmax, map_path)
    return weights, clusters


class TileSet:
    """All tile types including style variants, weights, and cached rotations."""

    REQUIRED = ("dead_end", "straight", "turn", "tee", "cross")

    def __init__(
        self,
        variants: dict[str, dict[str, tuple[Tile, float]]],
        clusters: dict[str, ClusterConfig],
    ):
        # variants[canonical name][style] = (Tile, weight)
        self.variants = variants
        # clusters[style] = ClusterConfig (min/max cells, optional bias map)
        self.clusters = clusters
        first = next(iter(next(iter(variants.values())).values()))[0]
        self.size = first.size
        self.height = first.height
        # cache[(canonical name, style, rotation)] -> Tile
        self._cache: dict[tuple[str, str, int], Tile] = {}

    @classmethod
    def load(cls, tiles_dir: str) -> "TileSet":
        weights, clusters = _load_config(tiles_dir)
        variants: dict[str, dict[str, tuple[Tile, float]]] = {}
        for name in CANONICAL_MASKS:
            alias, paths = _find_tile_files(tiles_dir, name)
            entries: dict[str, tuple[Tile, float]] = {}
            for path in paths:
                stem = os.path.splitext(os.path.basename(path))[0]
                weight = weights.get(stem, 1.0)
                if weight > 0:
                    entries[_style_of(stem, alias)] = (_load_tile(path, stem), weight)
            if entries:
                if DEFAULT_STYLE not in entries:
                    raise TileLoadError(
                        f"{tiles_dir}/{alias}: base variant '{alias}.litematic' is missing "
                        "or has weight 0."
                    )
                variants[name] = entries

        missing = [n for n in cls.REQUIRED if n not in variants]
        if missing:
            raise TileLoadError(
                f"Missing tiles in {tiles_dir}: " + ", ".join(missing)
            )

        all_tiles = [t for entries in variants.values() for t, _ in entries.values()]
        sizes = {(t.size, t.height) for t in all_tiles}
        if len(sizes) != 1:
            detail = ", ".join(f"{t.name}={t.size}x{t.height}x{t.size}" for t in all_tiles)
            raise TileLoadError(f"All tiles must be the same size: {detail}")
        return cls(variants, clusters)

    def style_weights(self) -> dict[str, float]:
        """Average weight per style across all tile types."""
        sums: dict[str, list[float]] = {}
        for entries in self.variants.values():
            for style, (_, weight) in entries.items():
                sums.setdefault(style, []).append(weight)
        return {style: sum(ws) / len(ws) for style, ws in sums.items()}

    def describe(self) -> str:
        lines = []
        for name, entries in self.variants.items():
            total = sum(w for _, w in entries.values())
            parts = ", ".join(f"{t.name} ({w:g}/{total:g})" for t, w in entries.values())
            lines.append(f"  {name:10s} {parts}")
        return "\n".join(lines)

    def get(self, name: str, rotation: int, style: str = DEFAULT_STYLE) -> Tile:
        """Tile for type + rotation + style; an unknown style falls back to the
        default (e.g. when a type has no slim variant)."""
        entries = self.variants[name]
        if style not in entries:
            style = DEFAULT_STYLE
        rotation %= 4
        key = (name, style, rotation)
        if key not in self._cache:
            if rotation == 0:
                self._cache[key] = entries[style][0]
            else:
                self._cache[key] = self.get(name, rotation - 1, style).rotated_cw()
        return self._cache[key]
