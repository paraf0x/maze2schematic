"""Setzt aus Maze + TileSet das Gesamt-Schematic zusammen.

Style-Zuweisung: Nicht-Default-Styles (z.B. "slim") werden als
zusammenhaengende Cluster entlang des Ganggraphen verteilt, mit
konfigurierbarer Min-/Max-Groesse (variants.json -> "clusters").
Der Flaechenanteil je Style richtet sich nach den Gewichten.

Optional steuert eine Bias-Map, wo die Cluster eines Styles bevorzugt
entstehen: ein Textraster in Labyrinth-Groesse, eine Ziffer 0-9 pro Zelle
('.' = 1). Hoehere Werte ziehen Seeds und Wachstum an, 0 sperrt die Zelle.
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
    """Liest eine Bias-Map: eine Zeile pro Labyrinth-Zeile, ein Zeichen pro
    Zelle. Erlaubt sind Ziffern 0-9 und '.' (= 1). Zeilen, die mit '#'
    beginnen, sind Kommentare."""
    with open(path) as f:
        lines = [line.rstrip("\n") for line in f if line.strip() and not line.startswith("#")]
    if len(lines) != maze.rows:
        raise BiasMapError(
            f"{path}: {len(lines)} Zeilen, aber das Labyrinth hat {maze.rows} Zeilen."
        )
    bias: BiasMap = []
    for r, line in enumerate(lines):
        if len(line) != maze.cols:
            raise BiasMapError(
                f"{path}: Zeile {r + 1} hat {len(line)} Zeichen, "
                f"aber das Labyrinth hat {maze.cols} Spalten."
            )
        row = []
        for ch in line:
            if ch == ".":
                row.append(1.0)
            elif ch.isdigit():
                row.append(float(ch))
            else:
                raise BiasMapError(f"{path}: ungueltiges Zeichen {ch!r} in Zeile {r + 1}.")
        bias.append(row)
    if all(v == 0 for row in bias for v in row):
        raise BiasMapError(f"{path}: alle Zellen sind 0, Style kann nirgends platziert werden.")
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
    """Zelle ist frei, nicht per Bias-Map gesperrt und grenzt (ueber Gaenge)
    nicht an denselben Style an -- sonst wuerden getrennt gewachsene Cluster
    zu einem groesseren verschmelzen."""
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
    """Laesst einen Cluster vom Seed aus entlang der Gaenge auf freien Zellen
    wachsen, bis `size` erreicht ist oder nichts mehr frei ist. Mit Bias-Map
    waechst der Cluster bevorzugt in Zellen mit hohem Bias."""
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
    """Weist jeder Zelle einen Style zu.

    Fuer jeden Nicht-Default-Style wird der Zielanteil aus den Gewichten
    bestimmt und in zusammenhaengenden Clustern (min/max Zellen) platziert.
    Ohne Cluster-Config gilt min = max = 1 (einzelne Zellen). Eine Bias-Map
    steuert, wo die Cluster bevorzugt entstehen.
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
            # Rejection-Sampling: Seeds proportional zum Bias annehmen
            if bias is not None and rng.random() * max_bias > bias[seed[0]][seed[1]]:
                continue
            size = rng.randint(cmin, min(cmax, target - placed))
            cluster = _grow_cluster(maze, grid, seed, size, style, bias, rng)
            if len(cluster) < cmin:
                continue  # eingeklemmt zwischen belegten Zellen: verwerfen
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
) -> Schematic:
    rng = rng if rng is not None else random.Random()
    if styles is None:
        styles = assign_styles(maze, tileset, rng)
    ts = tileset.size
    region = Region(0, 0, 0, maze.cols * ts, tileset.height, maze.rows * ts)

    for row in range(maze.rows):
        for col in range(maze.cols):
            tile_name, rotation = classify(maze.masks[row][col])
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
