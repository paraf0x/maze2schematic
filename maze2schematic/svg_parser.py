"""Parses a maze SVG in the "line maze" format (mazegenerator.net).

In this format the polylines aren't the walls but the walkable paths:
lines connect the centers of neighboring cells. Entrances/exits are
short stubs that extend past the cell-grid border.

Result: a set of open directions (N/E/S/W) per cell.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass

# Directions, clockwise (important for the rotation logic)
N, E, S, W = 0, 1, 2, 3
DIR_NAMES = {N: "N", E: "E", S: "S", W: "W"}


@dataclass
class Maze:
    rows: int
    cols: int
    # masks[row][col] = set of open directions {N, E, S, W}
    masks: list[list[set[int]]]


class SvgParseError(Exception):
    pass


def _parse_segments(svg_path: str) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Reads all polyline/line elements and returns axis-aligned segments."""
    tree = ET.parse(svg_path)
    segments = []
    for el in tree.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "polyline":
            raw = el.get("points", "").replace(",", " ").split()
            coords = [float(v) for v in raw]
            pts = list(zip(coords[0::2], coords[1::2]))
            segments.extend(zip(pts, pts[1:]))
        elif tag == "line":
            segments.append(
                (
                    (float(el.get("x1")), float(el.get("y1"))),
                    (float(el.get("x2")), float(el.get("y2"))),
                )
            )
    if not segments:
        raise SvgParseError("No polyline/line elements found in the SVG.")
    for (x1, y1), (x2, y2) in segments:
        if x1 != x2 and y1 != y2:
            raise SvgParseError(f"Non-axis-aligned segment: ({x1},{y1})-({x2},{y2})")
    return segments


def _infer_lattice(values: list[float]) -> tuple[float, float, int]:
    """Determines (origin, step, count) of the cell-center grid from coordinate values.

    Outliers (entrance/exit stubs that extend past the border) are ignored
    by picking the most common residue class modulo the step size.
    """
    distinct = sorted(set(values))
    if len(distinct) < 2:
        raise SvgParseError("Too few coordinate values to detect a grid.")
    diffs = [b - a for a, b in zip(distinct, distinct[1:])]
    step = Counter(diffs).most_common(1)[0][0]
    residues = Counter(round(v % step, 6) for v in distinct)
    residue = residues.most_common(1)[0][0]
    lattice = [v for v in distinct if round(v % step, 6) == residue]
    origin = lattice[0]
    count = int(round((lattice[-1] - origin) / step)) + 1
    return origin, step, count


def parse_svg(svg_path: str) -> Maze:
    segments = _parse_segments(svg_path)

    xs = [p[0] for seg in segments for p in seg]
    ys = [p[1] for seg in segments for p in seg]
    ox, step_x, cols = _infer_lattice(xs)
    oy, step_y, rows = _infer_lattice(ys)
    if step_x != step_y:
        raise SvgParseError(f"Different grid spacings x={step_x}, y={step_y}.")
    step = step_x

    def to_cell(v: float, origin: float) -> float:
        return (v - origin) / step

    masks: list[list[set[int]]] = [[set() for _ in range(cols)] for _ in range(rows)]

    def open_between(c1: tuple[int, int], c2: tuple[int, int]) -> None:
        (r1, col1), (r2, col2) = c1, c2
        if r2 == r1 and col2 == col1 + 1:
            masks[r1][col1].add(E)
            masks[r2][col2].add(W)
        elif r2 == r1 and col2 == col1 - 1:
            masks[r1][col1].add(W)
            masks[r2][col2].add(E)
        elif col2 == col1 and r2 == r1 + 1:
            masks[r1][col1].add(S)
            masks[r2][col2].add(N)
        elif col2 == col1 and r2 == r1 - 1:
            masks[r1][col1].add(N)
            masks[r2][col2].add(S)
        else:
            raise SvgParseError(f"Segment connects non-adjacent cells {c1} and {c2}.")

    def clamp_cell(cf: float, count: int) -> int:
        return max(0, min(count - 1, int(round(cf))))

    def on_lattice(cx: float, cy: float) -> bool:
        return (
            cx == int(cx) and cy == int(cy) and 0 <= cx < cols and 0 <= cy < rows
        )

    for (x1, y1), (x2, y2) in segments:
        cx1, cy1 = to_cell(x1, ox), to_cell(y1, oy)
        cx2, cy2 = to_cell(x2, ox), to_cell(y2, oy)
        on1 = on_lattice(cx1, cy1)
        on2 = on_lattice(cx2, cy2)

        if on1 and on2:
            # Path segment: open all cell pairs along the segment
            r1, c1 = int(cy1), int(cx1)
            r2, c2 = int(cy2), int(cx2)
            dr = (r2 > r1) - (r2 < r1)
            dc = (c2 > c1) - (c2 < c1)
            r, c = r1, c1
            while (r, c) != (r2, c2):
                open_between((r, c), (r + dr, c + dc))
                r, c = r + dr, c + dc
        elif on1 or on2:
            # Stub extending past the border: entrance/exit of the border cell
            (ix, iy) = (cx1, cy1) if on1 else (cx2, cy2)
            (fx, fy) = (cx2, cy2) if on1 else (cx1, cy1)
            r, c = int(iy), int(ix)
            if fy < iy:
                masks[r][c].add(N)
            elif fy > iy:
                masks[r][c].add(S)
            elif fx < ix:
                masks[r][c].add(W)
            else:
                masks[r][c].add(E)
        else:
            # Segment entirely outside the grid: e.g. the middle part of a
            # longer stub; attribute it to the nearest border cell.
            r = clamp_cell((cy1 + cy2) / 2, rows)
            c = clamp_cell((cx1 + cx2) / 2, cols)
            if (cy1 + cy2) / 2 < 0:
                masks[r][c].add(N)
            elif (cy1 + cy2) / 2 > rows - 1:
                masks[r][c].add(S)
            elif (cx1 + cx2) / 2 < 0:
                masks[r][c].add(W)
            else:
                masks[r][c].add(E)

    return Maze(rows=rows, cols=cols, masks=masks)
