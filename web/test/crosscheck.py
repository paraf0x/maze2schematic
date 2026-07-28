# web/test/crosscheck.py
"""Reads a .litematic produced by the web export with litemapy and checks
basic properties. Usage: .venv/bin/python web/test/crosscheck.py <file>
Expects a schematic built from the standard presets (20x20 maze, 5-wide tiles)."""
import sys

from litemapy import Schematic

path = sys.argv[1]
s = Schematic.load(path)
regions = list(s.regions.values())
assert len(regions) == 1, f"expected 1 region, found {len(regions)}"
r = regions[0]
w, h, l = abs(r.width), abs(r.height), abs(r.length)
assert w % 5 == 0 and l % 5 == 0, f"size {w}x{l} not on a 5-cell grid"
ids = {r[x, y, z].id for x in r.range_x() for y in r.range_y() for z in r.range_z()}
assert "minecraft:air" in ids, "no air in the schematic"
assert len(ids) >= 2, f"only {ids}"
print(f"OK: {w}x{h}x{l}, {len(ids)} block types, name={s.name!r}, author={s.author!r}")
