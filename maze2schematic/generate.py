"""Labyrinth-Generator, portiert von jsmaze (Dungeon Maze Generator).

Original: Morgan McGuire, @CasualEffects, https://casual-effects.com
https://morgan3d.github.io/misc/jsmaze/ (BSD-Lizenz)

Der Generator arbeitet auf einem Blockraster: EMPTY (0) = Gang,
SOLID (255) = Wand. Zellen liegen auf ungeraden Indizes, Waende dazwischen.
Hall-/Wall-Size aus dem Original entfaellt hier -- die Geometrie kommt
aus den Litematica-Tiles. Das Ergebnis wird in das Zellmasken-Modell
(`Maze`) konvertiert und laeuft durch die normale Tile-Pipeline.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from .svg_parser import E, Maze, N, S, W

SOLID, RESERVED, EMPTY = 255, 127, 0


@dataclass
class AxisOptions:
    loop: bool = False
    mirror: bool = False
    border: int = 1  # 0 oder 1 (dickere Raender ueber Tiles loesen)


@dataclass
class GenerateOptions:
    cols: int = 20
    rows: int = 20
    straightness: float = 0.0
    shortcuts: float = 0.0  # "imperfect" im Original: Anteil zusaetzlicher Loops
    coverage: float = 1.0   # "fill" im Original: wie viel Flaeche das Labyrinth fuellt
    rooms: float = 0.0      # Anteil der Sackgassen, die zu Raeumen werden
    horizontal: AxisOptions = field(default_factory=AxisOptions)
    vertical: AxisOptions = field(default_factory=AxisOptions)
    entrances: bool = True  # Ein-/Ausgang oben/unten in den Rand stanzen


# Presets von der jsmaze-Website (Hall-/Wall-Size entfaellt):
# (hloop, vloop, hborder, vborder, hmirror, vmirror, shortcuts, straightness, coverage, rooms)
DUNGEON_PRESETS: dict[str, tuple] = {
    "labyrinth": (False, False, 1, 1, False, False, 0.00, 0.00, 1.00, 0.00),
    "catacombs": (False, False, 1, 1, False, False, 0.00, 0.00, 0.20, 1.00),
    "hedge":     (False, False, 0, 0, False, False, 0.00, 0.00, 1.00, 0.15),
    "palace":    (False, False, 1, 1, False, False, 0.25, 0.00, 0.10, 0.50),
    "fortress":  (False, False, 1, 1, False, False, 0.75, 0.50, 0.15, 1.00),
    "suburb":    (False, False, 1, 1, False, False, 0.05, 0.90, 0.20, 1.00),
    "city":      (True,  True,  1, 1, False, False, 0.60, 0.00, 1.00, 1.00),
    "pacman":    (True,  False, 1, 1, True,  False, 0.25, 0.80, 1.00, 0.00),
    "starship":  (False, False, 1, 1, True,  False, 0.90, 0.10, 0.12, 1.00),
    "garden":    (False, False, 1, 1, True,  True,  1.00, 0.95, 0.50, 1.00),
    "forbidden": (False, False, 1, 1, True,  False, 0.20, 1.00, 0.50, 0.10),
}


def preset_options(name: str, cols: int, rows: int) -> GenerateOptions:
    hl, vl, hb, vb, hm, vm, shortcuts, straightness, coverage, rooms = DUNGEON_PRESETS[name]
    return GenerateOptions(
        cols=cols,
        rows=rows,
        straightness=straightness,
        shortcuts=shortcuts,
        coverage=coverage,
        rooms=rooms,
        horizontal=AxisOptions(loop=hl, mirror=hm, border=hb),
        vertical=AxisOptions(loop=vl, mirror=vm, border=vb),
    )


def _make_maze(
    w: int,
    h: int,
    horizontal: AxisOptions,
    vertical: AxisOptions,
    straightness: float,
    imperfect: float,
    fill: float,
    dead_ends: list[list[int]],
    rng: random.Random,
) -> list[list[int]]:
    """Direkte Portierung von makeMaze() aus jsmaze (hall/wall = 1)."""
    h_symmetry = horizontal.mirror
    h_border = horizontal.border
    # Wrapping ignorieren, ausser Border und Symmetrie sind gesetzt; dann ohne
    # Wrapping generieren und Loecher in den Rand stanzen
    h_wrap = horizontal.loop and not (h_symmetry and h_border)

    v_symmetry = vertical.mirror
    v_border = vertical.border
    v_wrap = vertical.loop and not (v_symmetry and v_border)

    def random_int(x: float) -> int:
        return math.floor(rng.random() * x)

    def shuffle(a: list) -> None:
        for i in range(len(a) - 1, 0, -1):
            j = random_int(i + 1)
            a[i], a[j] = a[j], a[i]

    # Raender, die spaeter entfernt werden, vorab ausgleichen
    if not h_border:
        w += 1
        if not h_wrap:
            w += 1
    if not v_border:
        h += 1
        if not v_wrap:
            h += 1

    imperfect = min(1.0, max(0.0, imperfect))
    reserve_prob = (1 - min(max(0.0, fill * 0.9 + 0.1), 1.0)) ** 1.6

    if h_wrap:
        if h_symmetry:
            w = round((w - 2) / 4) * 4 + 2
        else:
            w += w & 1
    else:
        w += ~(w & 1)

    if v_wrap:
        if v_symmetry:
            h = round((h - 2) / 4) * 4 + 2
        else:
            h += h & 1
    else:
        h += ~(h & 1)

    maze = [[SOLID] * h for _ in range(w)]

    if reserve_prob > 0:
        for x in range(1, w, 2):
            for y in range(1, h, 2):
                if rng.random() < reserve_prob:
                    maze[x][y] = RESERVED

    # Gaenge ausgraben (DFS), Start in der Mitte
    start_step = (0, 0)
    stack = [((w // 4) * 2 - 1, (h // 4) * 2 - 1, start_step)]
    dead_ends.append([stack[0][0], stack[0][1]])
    directions = [(-1, 0), (1, 0), (0, 1), (0, -1)]

    # Reservierte Zellen erst beruecksichtigen, wenn ein Mindestpfad existiert
    ignore_reserved = max(w, h)

    def unexplored(x: int, y: int) -> bool:
        c = maze[x][y]
        return c == SOLID or (c == RESERVED and ignore_reserved > 0)

    h_border_offset = 0 if h_wrap else 1
    v_border_offset = 0 if v_wrap else 1

    def set_cell(x: int, y: int, value: int) -> None:
        x = (x + w) % w
        y = (y + h) % h
        maze[x][y] = value
        u = w - x - h_border_offset
        v = h - y - v_border_offset
        if h_symmetry and u < w:
            maze[u][y] = value
            if v_symmetry and v < h:
                maze[u][v] = value
        if v_symmetry and v < h:
            maze[x][v] = value

    while stack:
        cx, cy, step = stack.pop()
        if not unexplored(cx, cy):
            continue
        set_cell(cx, cy, EMPTY)
        # Wand Richtung Ursprung ebenfalls oeffnen
        set_cell(cx - step[0], cy - step[1], EMPTY)
        ignore_reserved -= 1

        shuffle(directions)

        # Geradeaus bevorzugen: den letzten Schritt ans Ende sortieren
        # (der Stack ist LIFO, das letzte Element wird zuerst verarbeitet)
        if rng.random() < straightness:
            for i in range(4):
                if directions[i] is step:
                    directions[i] = directions[3]
                    directions[3] = step
                    break

        dead_end = True
        for step_dir in list(directions):
            x = cx + step_dir[0] * 2
            y = cy + step_dir[1] * 2
            if h_wrap:
                x = (x + w) % w
            if v_wrap:
                y = (y + h) % h
            if 0 <= x < w and 0 <= y < h and unexplored(x, y):
                stack.append((x, y, step_dir))
                dead_end = False

        if dead_end:
            dead_ends.append([cx, cy])

    if imperfect > 0:
        h_bdry = 0 if h_wrap else 1
        v_bdry = 0 if v_wrap else 1

        def remove(x: int, y: int) -> None:
            a = maze[x][(y + 1) % h]
            b = maze[x][(y - 1 + h) % h]
            c = maze[(x + 1) % w][y]
            d = maze[(x - 1 + w) % w][y]
            if min(a, b, c, d) == EMPTY:
                set_cell(x, y, EMPTY)

        for _ in range(math.ceil(imperfect * w * h / 3)):
            remove(random_int(w * 0.5 - h_bdry * 2) * 2 + 1,
                   random_int(h * 0.5 - v_bdry * 2) * 2 + v_bdry * 2)
            remove(random_int(w * 0.5 - h_bdry * 2) * 2 + h_bdry * 2,
                   random_int(h * 0.5 - v_bdry * 2) * 2 + 1)

        # Einzelne Wand-Inseln wieder anbinden
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                a = maze[x][(y + 1) % h]
                b = maze[x][(y - 1 + h) % h]
                c = maze[(x + 1) % w][y]
                d = maze[(x - 1 + w) % w][y]
                if a == EMPTY and b == EMPTY and c == EMPTY and d == EMPTY:
                    dx, dy = directions[random_int(4)]
                    set_cell(x + dx, y + dy, SOLID)

    # Reservierungen aufheben
    if reserve_prob > 0:
        for x in range(1, w, 2):
            for y in range(1, h, 2):
                if maze[x][y] == RESERVED:
                    maze[x][y] = SOLID

    if horizontal.loop and h_border and h_symmetry:
        prob = 0.025 + 0.25 * (1 - straightness ** 2 * (1 - imperfect)) + 0.5 * imperfect
        for y in range(1, len(maze[0]), 2):
            if maze[1][y] == EMPTY and (y < 2 or maze[0][y - 2] != EMPTY) and rng.random() < prob:
                maze[0][y] = EMPTY
                maze[-1][y] = EMPTY

    if vertical.loop and v_border and v_symmetry:
        prob = 0.05 + 0.15 * (1 - straightness * (1 - imperfect)) + 0.5 * imperfect
        for x in range(1, len(maze), 2):
            if maze[x][1] == EMPTY and (x < 2 or maze[x - 2][0] != EMPTY) and rng.random() < prob:
                maze[x][0] = EMPTY
                maze[x][-1] = EMPTY

    # Horizontale Raender
    if not h_wrap and not h_border:
        maze.pop(0)
        maze.pop()
        for de in dead_ends:
            de[0] -= 1
    elif h_border and h_wrap and not h_symmetry:
        # Linke Kante rechts duplizieren
        maze.append(list(maze[0]))
        for de in list(dead_ends):
            if de[0] == 0:
                dead_ends.append([len(maze) - 1, de[1]])
    elif h_symmetry and h_wrap:
        maze.pop(0)
        maze.pop(0)
        for de in dead_ends:
            de[0] -= 2

    # Vertikale Raender
    if v_border and v_wrap and not v_symmetry:
        for col in maze:
            col.append(col[0])
        for de in list(dead_ends):
            if de[1] == 0:
                dead_ends.append([de[0], len(maze[0]) - 1])
    elif not v_wrap and not v_border:
        for col in maze:
            col.pop(0)
            col.pop()
        for de in dead_ends:
            de[1] -= 1
    elif v_symmetry and v_wrap:
        for col in maze:
            col.pop(0)
            col.pop(0)
        for de in dead_ends:
            de[1] -= 2

    # Sackgassen ausserhalb des Rasters entfernen
    dead_ends[:] = [de for de in dead_ends if de[0] >= 0 and de[1] >= 0]

    return maze


def _add_rooms(
    lattice: list[list[int]],
    horizontal: AxisOptions,
    vertical: AxisOptions,
    dead_ends: list[list[int]],
    rooms_fraction: float,
) -> None:
    """Portierung von addMapRooms() aus jsmaze (hall/wall = 1)."""
    w, h = len(lattice), len(lattice[0])
    rooms_fraction = max(0.0, min(1.0, rooms_fraction))

    # Raumgroesse (im Original abhaengig von hall+wall = 2)
    a = math.ceil(0.6 * 2 / max(rooms_fraction, 0.4))
    b = a

    last = math.floor((len(dead_ends) - 1) * rooms_fraction)
    for i in range(last, -1, -1):
        cx, cy = dead_ends[i]
        u = math.floor(cx - a / 2)
        v = math.floor(cy - b / 2)
        for x in range(max(1, u - a), min(w - 2, u + a) + 1):
            lo, hi = max(1, v - b), min(h - 1, v + b + 1)
            for y in range(lo, hi):
                lattice[x][y] = EMPTY

    # Symmetrie wiederherstellen
    if horizontal.mirror:
        offset = 2 if horizontal.loop else 1
        for y in range(h):
            for x in range(w // 2 + 1):
                lattice[w - offset - x][y] = lattice[x][y]
    if vertical.mirror:
        offset = 2 if vertical.loop else 1
        for x in range(w):
            for y in range(h // 2 + 1):
                lattice[x][h - offset - y] = lattice[x][y]


def _lattice_to_maze(lattice: list[list[int]], x_phase: int, y_phase: int) -> Maze:
    """Konvertiert das Blockraster in Zellmasken.

    Zellen liegen bei Index `1 - phase + 2k`. Nicht ausgegrabene Zellen
    (SOLID) bekommen eine leere Maske (-> closed-Tile). Raum-Ausgrabungen auf
    Wandpfosten (gerade/gerade) koennen Tiles nicht abbilden; die Pfosten der
    Tiles bleiben dann als Saeulen stehen.
    """
    lw, lh = len(lattice), len(lattice[0])
    xs = list(range(1 - x_phase, lw, 2))
    ys = list(range(1 - y_phase, lh, 2))
    rows, cols = len(ys), len(xs)

    masks = [[set() for _ in range(cols)] for _ in range(rows)]
    for r, ly in enumerate(ys):
        for c, lx in enumerate(xs):
            if lattice[lx][ly] != EMPTY:
                continue
            for d, (dx, dy) in ((N, (0, -1)), (E, (1, 0)), (S, (0, 1)), (W, (-1, 0))):
                wx, wy = lx + dx, ly + dy
                if not (0 <= wx < lw and 0 <= wy < lh) or lattice[wx][wy] != EMPTY:
                    continue
                # Kante nur oeffnen, wenn auch die Nachbarzelle ausgegraben ist.
                # (Bei coverage < 1 kann das Original Wandnischen erzeugen, die
                # das Tile-Modell nicht abbilden kann.) Nachbarn ausserhalb des
                # Rasters (Loop-/Randoeffnungen) zaehlen als offen.
                nx, ny = lx + 2 * dx, ly + 2 * dy
                if 0 <= nx < lw and 0 <= ny < lh and lattice[nx][ny] != EMPTY:
                    continue
                masks[r][c].add(d)
    return Maze(rows=rows, cols=cols, masks=masks)


def generate_maze(opts: GenerateOptions, rng: random.Random) -> Maze:
    """Erzeugt ein Labyrinth mit dem jsmaze-Algorithmus als Zellmasken-Maze."""
    # Ziel: bei Border + ohne Wrap exakt cols x rows Zellen. makeMaze macht aus
    # geradem w per `w += ~(w & 1)` genau w-1 (ungerade) -> 2*cols+2 einspeisen.
    lattice = _make_maze(
        w=2 * opts.cols + 2,
        h=2 * opts.rows + 2,
        horizontal=opts.horizontal,
        vertical=opts.vertical,
        straightness=opts.straightness,
        imperfect=opts.shortcuts,
        fill=opts.coverage,
        dead_ends=(dead_ends := []),
        rng=rng,
    )

    if opts.rooms > 0:
        _add_rooms(lattice, opts.horizontal, opts.vertical, dead_ends, opts.rooms)

    h_wrap = opts.horizontal.loop and not (opts.horizontal.mirror and opts.horizontal.border)
    v_wrap = opts.vertical.loop and not (opts.vertical.mirror and opts.vertical.border)
    x_phase = 1 if (not opts.horizontal.border and not h_wrap) else 0
    y_phase = 1 if (not opts.vertical.border and not v_wrap) else 0
    maze = _lattice_to_maze(lattice, x_phase, y_phase)

    # Ein-/Ausgang oben/unten in den Rand stanzen (nur wenn der Rand zu ist)
    if opts.entrances and opts.vertical.border and not v_wrap:
        top = [c for c in range(maze.cols) if maze.masks[0][c]]
        bottom = [c for c in range(maze.cols) if maze.masks[-1][c]]
        if top:
            maze.masks[0][rng.choice(top)].add(N)
        if bottom:
            maze.masks[-1][rng.choice(bottom)].add(S)

    return maze
