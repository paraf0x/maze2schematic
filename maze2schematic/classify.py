"""Maps each cell mask (open directions) to a tile type + rotation.

Canonical tile orientations (rotation 0):
- dead_end: open to the north
- straight: open north and south
- turn:     open north and east
- tee:      open east, south and west (closed to the north)
- cross:    all four sides open
- closed:   all sides closed

Rotation is in 90-degree clockwise steps (0..3).
"""

from __future__ import annotations

from .svg_parser import N, E, S, W

CANONICAL_MASKS: dict[str, frozenset[int]] = {
    "closed": frozenset(),
    "dead_end": frozenset({N}),
    "straight": frozenset({N, S}),
    "turn": frozenset({N, E}),
    "tee": frozenset({E, S, W}),
    "cross": frozenset({N, E, S, W}),
}

TILE_NAMES = list(CANONICAL_MASKS)


def rotate_mask(mask: frozenset[int], times: int) -> frozenset[int]:
    """Rotates a set of directions by `times` * 90 degrees clockwise."""
    return frozenset((d + times) % 4 for d in mask)


# Lookup: mask -> (tile name, rotation). For ambiguous rotations
# (straight 0/2, cross all) the smallest rotation wins.
_LOOKUP: dict[frozenset[int], tuple[str, int]] = {}
for _name, _canonical in CANONICAL_MASKS.items():
    for _r in range(4):
        _LOOKUP.setdefault(rotate_mask(_canonical, _r), (_name, _r))


def classify(mask: set[int]) -> tuple[str, int]:
    """Returns (tile name, clockwise rotation 0..3) for a cell mask."""
    return _LOOKUP[frozenset(mask)]
