"""Ordnet jeder Zellmaske (offene Richtungen) einen Tile-Typ + Rotation zu.

Kanonische Ausrichtungen der Tiles (Rotation 0):
- dead_end: offen nach Norden
- straight: offen Nord und Sued
- turn:     offen Nord und Ost
- tee:      offen Ost, Sued und West (geschlossen nach Norden)
- cross:    alle vier Seiten offen
- closed:   alle Seiten zu

Rotation ist in 90-Grad-Schritten im Uhrzeigersinn (0..3).
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
    """Rotiert eine Richtungsmenge um `times` * 90 Grad im Uhrzeigersinn."""
    return frozenset((d + times) % 4 for d in mask)


# Lookup: Maske -> (Tile-Name, Rotation). Bei mehrdeutigen Rotationen
# (straight 0/2, cross alle) gewinnt die kleinste Rotation.
_LOOKUP: dict[frozenset[int], tuple[str, int]] = {}
for _name, _canonical in CANONICAL_MASKS.items():
    for _r in range(4):
        _LOOKUP.setdefault(rotate_mask(_canonical, _r), (_name, _r))


def classify(mask: set[int]) -> tuple[str, int]:
    """Liefert (Tile-Name, Rotation im Uhrzeigersinn 0..3) fuer eine Zellmaske."""
    return _LOOKUP[frozenset(mask)]
