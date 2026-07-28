"""CLI: python -m maze2schematic (MAZE.svg | --generate WxH) [--tiles tiles/] [-o out.litematic]"""

from __future__ import annotations

import argparse
import random
import sys

from .assemble import BiasMapError, assemble, assign_styles, style_stats, tile_stats
from .generate import DUNGEON_PRESETS, GenerateOptions, generate_maze, preset_options
from .svg_parser import E, N, S, W, parse_svg
from .tiles import TileLoadError, TileSet

# Box-Drawing-Zeichen je Menge offener Richtungen
_PREVIEW_CHARS = {
    frozenset(): "·",
    frozenset({N}): "╵",
    frozenset({E}): "╶",
    frozenset({S}): "╷",
    frozenset({W}): "╴",
    frozenset({N, E}): "└",
    frozenset({N, S}): "│",
    frozenset({N, W}): "┘",
    frozenset({E, S}): "┌",
    frozenset({E, W}): "─",
    frozenset({S, W}): "┐",
    frozenset({N, E, S}): "├",
    frozenset({N, E, W}): "┴",
    frozenset({N, S, W}): "┤",
    frozenset({E, S, W}): "┬",
    frozenset({N, E, S, W}): "┼",
}


def print_preview(maze) -> None:
    print(f"Erkanntes Labyrinth: {maze.cols} x {maze.rows} Zellen")
    for row in maze.masks:
        print("".join(_PREVIEW_CHARS[frozenset(mask)] for mask in row))


def _parse_size(value: str) -> tuple[int, int]:
    try:
        cols, rows = (int(v) for v in value.lower().split("x"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"Groesse muss SPALTENxZEILEN sein, z.B. 20x20: {value!r}")
    if cols < 2 or rows < 2:
        raise argparse.ArgumentTypeError("Groesse muss mindestens 2x2 sein.")
    return cols, rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="maze2schematic",
        description=(
            "Baut aus einer Labyrinth-SVG oder einem generierten Labyrinth "
            "(jsmaze-Algorithmus) und Litematica-Tiles ein Gesamt-Schematic."
        ),
    )
    parser.add_argument("svg", nargs="?", help="Pfad zur Labyrinth-SVG (Line-Maze-Format)")
    parser.add_argument("--tiles", default="tiles", help="Ordner mit Tile-Schematics (Default: tiles)")
    parser.add_argument("-o", "--out", default="maze.litematic", help="Ausgabedatei (Default: maze.litematic)")
    parser.add_argument("--name", default="maze", help="Name des Schematics")
    parser.add_argument("--author", default="maze2schematic", help="Autor des Schematics")
    parser.add_argument("--seed", type=int, default=None, help="Seed fuer Generator und Variantenauswahl (reproduzierbar)")
    parser.add_argument("--preview", action="store_true", help="Nur ASCII-Vorschau ausgeben, kein Schematic schreiben")
    parser.add_argument(
        "--map-template",
        metavar="DATEI",
        help="Leere Bias-Map-Vorlage in Labyrinth-Groesse schreiben und beenden",
    )

    gen = parser.add_argument_group(
        "Generator (jsmaze von Morgan McGuire, statt SVG)"
    )
    gen.add_argument("--generate", metavar="WxH", type=_parse_size, help="Labyrinth generieren, Groesse in Zellen, z.B. 20x20")
    gen.add_argument("--dungeon", choices=sorted(DUNGEON_PRESETS), help="Parameter-Preset der jsmaze-Website")
    gen.add_argument("--straightness", type=float, help="Geradlinigkeit der Gaenge 0..1 (Default 0)")
    gen.add_argument("--shortcuts", type=float, help="Anteil zusaetzlicher Loops 0..1 (Default 0)")
    gen.add_argument("--coverage", type=float, help="Flaechenfuellung 0..1 (Default 1; <1 laesst massive Bereiche)")
    gen.add_argument("--rooms", type=float, help="Raeume an Sackgassen 0..1 (Default 0)")
    gen.add_argument("--h-loop", action="store_true", default=None, help="horizontal umlaufend (Torus)")
    gen.add_argument("--v-loop", action="store_true", default=None, help="vertikal umlaufend (Torus)")
    gen.add_argument("--h-mirror", action="store_true", default=None, help="horizontal spiegeln")
    gen.add_argument("--v-mirror", action="store_true", default=None, help="vertikal spiegeln")
    gen.add_argument("--no-h-border", action="store_true", help="ohne linken/rechten Rand")
    gen.add_argument("--no-v-border", action="store_true", help="ohne oberen/unteren Rand")
    gen.add_argument("--no-entrances", action="store_true", help="keinen Ein-/Ausgang in den Rand stanzen")
    args = parser.parse_args(argv)

    if (args.svg is None) == (args.generate is None):
        parser.error("entweder eine SVG-Datei ODER --generate WxH angeben")

    rng = random.Random(args.seed)

    if args.svg is not None:
        maze = parse_svg(args.svg)
    else:
        cols, rows = args.generate
        opts = preset_options(args.dungeon, cols, rows) if args.dungeon else GenerateOptions(cols=cols, rows=rows)
        if args.straightness is not None:
            opts.straightness = args.straightness
        if args.shortcuts is not None:
            opts.shortcuts = args.shortcuts
        if args.coverage is not None:
            opts.coverage = args.coverage
        if args.rooms is not None:
            opts.rooms = args.rooms
        if args.h_loop is not None:
            opts.horizontal.loop = args.h_loop
        if args.v_loop is not None:
            opts.vertical.loop = args.v_loop
        if args.h_mirror is not None:
            opts.horizontal.mirror = args.h_mirror
        if args.v_mirror is not None:
            opts.vertical.mirror = args.v_mirror
        if args.no_h_border:
            opts.horizontal.border = 0
        if args.no_v_border:
            opts.vertical.border = 0
        if args.no_entrances:
            opts.entrances = False
        maze = generate_maze(opts, rng)

    if args.map_template:
        with open(args.map_template, "w") as f:
            f.write(f"# Bias-Map {maze.cols}x{maze.rows}: Ziffern 0-9, '.' = 1, 0 = gesperrt\n")
            for _ in range(maze.rows):
                f.write("." * maze.cols + "\n")
        print(f"Vorlage geschrieben: {args.map_template} ({maze.cols}x{maze.rows})")
        return 0

    if args.preview:
        print_preview(maze)
        stats = tile_stats(maze)
        print("\nTile-Verteilung:")
        for tile_name, count in stats.most_common():
            print(f"  {tile_name:10s} {count}")
        return 0

    try:
        tileset = TileSet.load(args.tiles)
    except TileLoadError as err:
        print(f"Fehler beim Laden der Tiles: {err}", file=sys.stderr)
        print(
            "Tipp: Beispiel-Tiles erzeugen mit: python -m maze2schematic.make_default_tiles",
            file=sys.stderr,
        )
        return 1

    try:
        styles = assign_styles(maze, tileset, rng)
    except BiasMapError as err:
        print(f"Fehler in der Bias-Map: {err}", file=sys.stderr)
        return 1

    if any(len(entries) > 1 for entries in tileset.variants.values()):
        print("Tile-Varianten (Gewicht/Summe):")
        print(tileset.describe())
        counts = style_stats(styles)
        parts = ", ".join(
            f"{style or 'default'}={n}" for style, n in counts.most_common()
        )
        print(f"Style-Verteilung ({maze.rows * maze.cols} Zellen): {parts}")

    schem = assemble(maze, tileset, name=args.name, author=args.author, rng=rng, styles=styles)
    schem.save(args.out)

    ts = tileset.size
    print(
        f"OK: {maze.cols}x{maze.rows} Zellen, Tile-Groesse {ts}x{tileset.height}x{ts} "
        f"-> {maze.cols * ts}x{tileset.height}x{maze.rows * ts} Bloecke"
    )
    print(f"geschrieben: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
