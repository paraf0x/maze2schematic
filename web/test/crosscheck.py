# web/test/crosscheck.py
"""Liest ein vom Web-Export erzeugtes .litematic mit litemapy und prueft
Grundeigenschaften. Aufruf: .venv/bin/python web/test/crosscheck.py <datei>
Erwartet ein Schematic aus Standard-Presets (20x20-Maze, 5er-Tiles)."""
import sys

from litemapy import Schematic

path = sys.argv[1]
s = Schematic.load(path)
regions = list(s.regions.values())
assert len(regions) == 1, f"1 Region erwartet, {len(regions)} gefunden"
r = regions[0]
w, h, l = abs(r.width), abs(r.height), abs(r.length)
assert w % 5 == 0 and l % 5 == 0, f"Groesse {w}x{l} kein 5er-Raster"
ids = {r[x, y, z].id for x in r.range_x() for y in r.range_y() for z in r.range_z()}
assert "minecraft:air" in ids, "keine Luft im Schematic"
assert len(ids) >= 2, f"nur {ids}"
print(f"OK: {w}x{h}x{l}, {len(ids)} Blocktypen, Name={s.name!r}, Autor={s.author!r}")
