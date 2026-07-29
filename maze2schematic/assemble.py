"""Assembles the complete schematic from Maze + TileSet.

Style assignment: non-default styles (e.g. "slim") are distributed as
connected clusters along the corridor graph, with configurable min/max
size (variants.json -> "clusters"). The area share per style follows
the weights.

Optionally a bias map controls where a style's clusters preferentially
form: a text grid sized to the maze, one digit 0-9 per cell ('.' = 1).
Higher values attract seeds and growth, 0 blocks the cell.
"""

from __future__ import annotations

import random
from collections import Counter

from litemapy import Region, Schematic

from .classify import classify
from .svg_parser import E, Maze, N, S, W
from .tiles import DEFAULT_STYLE, ClusterConfig, TileSet

StyleGrid = list[list[str]]
BiasMap = list[list[float]]


class BiasMapError(Exception):
    pass


def load_bias_map(path: str, maze: Maze) -> BiasMap:
    """Reads a bias map: one line per maze row, one character per cell.
    Digits 0-9 and '.' (= 1) are allowed. Lines starting with '#' are
    comments."""
    with open(path) as f:
        lines = [line.rstrip("\n") for line in f if line.strip() and not line.startswith("#")]
    if len(lines) != maze.rows:
        raise BiasMapError(
            f"{path}: {len(lines)} lines, but the maze has {maze.rows} rows."
        )
    bias: BiasMap = []
    for r, line in enumerate(lines):
        if len(line) != maze.cols:
            raise BiasMapError(
                f"{path}: line {r + 1} has {len(line)} characters, "
                f"but the maze has {maze.cols} columns."
            )
        row = []
        for ch in line:
            if ch == ".":
                row.append(1.0)
            elif ch.isdigit():
                row.append(float(ch))
            else:
                raise BiasMapError(f"{path}: invalid character {ch!r} on line {r + 1}.")
        bias.append(row)
    if all(v == 0 for row in bias for v in row):
        raise BiasMapError(f"{path}: all cells are 0, the style can't be placed anywhere.")
    return bias


def _neighbors(maze: Maze, r: int, c: int):
    for d in maze.masks[r][c]:
        nr = r + (d == S) - (d == N)
        nc = c + (d == E) - (d == W)
        if 0 <= nr < maze.rows and 0 <= nc < maze.cols:
            yield nr, nc


def _free_for(
    maze: Maze,
    grid: StyleGrid,
    cell: tuple[int, int],
    style: str,
    bias: BiasMap | None,
) -> bool:
    """Cell is free, not blocked by the bias map, and (via corridors) does
    not border the same style -- otherwise separately grown clusters would
    merge into one larger cluster."""
    r, c = cell
    if grid[r][c] is not None:
        return False
    if bias is not None and bias[r][c] <= 0:
        return False
    return all(grid[nr][nc] != style for nr, nc in _neighbors(maze, r, c))


def _grow_cluster(
    maze: Maze,
    grid: StyleGrid,
    seed: tuple[int, int],
    size: int,
    style: str,
    bias: BiasMap | None,
    rng: random.Random,
) -> set[tuple[int, int]]:
    """Grows a cluster from the seed along the corridors into free cells
    until `size` is reached or nothing is free anymore. With a bias map the
    cluster preferentially grows into cells with a high bias."""
    cluster = {seed}
    frontier = [seed]
    while frontier and len(cluster) < size:
        if bias is None:
            index = rng.randrange(len(frontier))
        else:
            index = rng.choices(
                range(len(frontier)), weights=[bias[r][c] for r, c in frontier]
            )[0]
        cell = frontier.pop(index)
        for nb in _neighbors(maze, *cell):
            if len(cluster) >= size:
                break
            if nb not in cluster and _free_for(maze, grid, nb, style, bias):
                cluster.add(nb)
                frontier.append(nb)
    return cluster


def assign_styles(maze: Maze, tileset: TileSet, rng: random.Random) -> StyleGrid:
    """Assigns a style to every cell.

    For each non-default style the target share is computed from the
    weights and placed in connected clusters (min/max cells). Without a
    cluster config, min = max = 1 (single cells) applies. A bias map
    controls where the clusters preferentially form.
    """
    grid: StyleGrid = [[None] * maze.cols for _ in range(maze.rows)]
    weights = tileset.style_weights()
    total_weight = sum(weights.values())
    total_cells = maze.rows * maze.cols

    for style, weight in weights.items():
        if style == DEFAULT_STYLE:
            continue
        target = round(total_cells * weight / total_weight)
        cfg = tileset.clusters.get(style, ClusterConfig())
        cmin, cmax = cfg.min_size, cfg.max_size
        bias = load_bias_map(cfg.map_path, maze) if cfg.map_path else None
        max_bias = max(v for row in bias for v in row) if bias else 1.0
        placed = 0
        attempts = 0
        max_attempts = total_cells * 10
        while placed + cmin <= target and attempts < max_attempts:
            attempts += 1
            seed = (rng.randrange(maze.rows), rng.randrange(maze.cols))
            if not _free_for(maze, grid, seed, style, bias):
                continue
            # Rejection sampling: accept seeds proportional to the bias
            if bias is not None and rng.random() * max_bias > bias[seed[0]][seed[1]]:
                continue
            size = rng.randint(cmin, min(cmax, target - placed))
            cluster = _grow_cluster(maze, grid, seed, size, style, bias, rng)
            if len(cluster) < cmin:
                continue  # wedged between occupied cells: discard
            for r, c in cluster:
                grid[r][c] = style
            placed += len(cluster)

    for r in range(maze.rows):
        for c in range(maze.cols):
            if grid[r][c] is None:
                grid[r][c] = DEFAULT_STYLE
    return grid


def style_stats(grid: StyleGrid) -> Counter:
    return Counter(style for row in grid for style in row)


def assemble(
    maze: Maze,
    tileset: TileSet,
    name: str = "maze",
    author: str = "maze2schematic",
    rng: random.Random | None = None,
    styles: StyleGrid | None = None,
    skip_closed: bool = False,
) -> Schematic:
    rng = rng if rng is not None else random.Random()
    if styles is None:
        styles = assign_styles(maze, tileset, rng)
    ts = tileset.size
    region = Region(0, 0, 0, maze.cols * ts, tileset.height, maze.rows * ts)

    # Closed cells stay empty (air) when requested or when the tile set has
    # no closed tile at all -- the region is air by default, so skipping the
    # cell is all it takes.
    skip_closed = skip_closed or "closed" not in tileset.variants

    for row in range(maze.rows):
        for col in range(maze.cols):
            tile_name, rotation = classify(maze.masks[row][col])
            if tile_name == "closed" and skip_closed:
                continue
            tile = tileset.get(tile_name, rotation, styles[row][col])
            ox, oz = col * ts, row * ts
            for x in range(ts):
                for y in range(tileset.height):
                    for z in range(ts):
                        region[ox + x, y, oz + z] = tile.blocks[x][y][z]

    schem = region.as_schematic(name=name, author=author)
    return schem


def tile_stats(maze: Maze) -> Counter:
    counts: Counter = Counter()
    for row in maze.masks:
        for mask in row:
            counts[classify(mask)[0]] += 1
    return counts
