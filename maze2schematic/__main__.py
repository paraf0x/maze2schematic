"""CLI: python -m maze2schematic (MAZE.svg | --generate WxH) [--tiles tiles/] [-o out.litematic]"""

from __future__ import annotations

import argparse
import random
import sys

from .assemble import BiasMapError, assemble, assign_styles, style_stats, tile_stats
from .generate import DUNGEON_PRESETS, GenerateOptions, generate_maze, preset_options
from .svg_parser import E, N, S, W, parse_svg
from .tiles import TileLoadError, TileSet

# Box-drawing character per set of open directions
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
    print(f"Detected maze: {maze.cols} x {maze.rows} cells")
    for row in maze.masks:
        print("".join(_PREVIEW_CHARS[frozenset(mask)] for mask in row))


def _parse_size(value: str) -> tuple[int, int]:
    try:
        cols, rows = (int(v) for v in value.lower().split("x"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"Size must be COLSxROWS, e.g. 20x20: {value!r}")
    if cols < 2 or rows < 2:
        raise argparse.ArgumentTypeError("Size must be at least 2x2.")
    return cols, rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="maze2schematic",
        description=(
            "Builds a complete schematic from a maze SVG or a generated maze "
            "(jsmaze algorithm) and Litematica tiles."
        ),
    )
    parser.add_argument("svg", nargs="?", help="Path to the maze SVG (line-maze format)")
    parser.add_argument("--tiles", default="tiles", help="Folder with tile schematics (default: tiles)")
    parser.add_argument("-o", "--out", default="maze.litematic", help="Output file (default: maze.litematic)")
    parser.add_argument("--name", default="maze", help="Name of the schematic")
    parser.add_argument("--author", default="maze2schematic", help="Author of the schematic")
    parser.add_argument("--seed", type=int, default=None, help="Seed for the generator and variant selection (reproducible)")
    parser.add_argument("--preview", action="store_true", help="Print an ASCII preview only, don't write a schematic")
    parser.add_argument(
        "--no-closed",
        action="store_true",
        help="Leave closed cells empty (air) instead of placing the closed tile",
    )
    parser.add_argument(
        "--map-template",
        metavar="FILE",
        help="Write an empty bias-map template sized to the maze and exit",
    )

    gen = parser.add_argument_group(
        "Generator (jsmaze by Morgan McGuire, instead of SVG)"
    )
    gen.add_argument("--generate", metavar="WxH", type=_parse_size, help="Generate a maze, size in cells, e.g. 20x20")
    gen.add_argument("--dungeon", choices=sorted(DUNGEON_PRESETS), help="Parameter preset from the jsmaze website")
    gen.add_argument("--straightness", type=float, help="Straightness of corridors 0..1 (default 0)")
    gen.add_argument("--shortcuts", type=float, help="Fraction of extra loops 0..1 (default 0)")
    gen.add_argument("--coverage", type=float, help="Area fill 0..1 (default 1; <1 leaves solid areas)")
    gen.add_argument("--rooms", type=float, help="Rooms at dead ends 0..1 (default 0)")
    gen.add_argument("--h-loop", action="store_true", default=None, help="horizontal wraparound (torus)")
    gen.add_argument("--v-loop", action="store_true", default=None, help="vertical wraparound (torus)")
    gen.add_argument("--h-mirror", action="store_true", default=None, help="mirror horizontally")
    gen.add_argument("--v-mirror", action="store_true", default=None, help="mirror vertically")
    gen.add_argument("--no-h-border", action="store_true", help="without left/right border")
    gen.add_argument("--no-v-border", action="store_true", help="without top/bottom border")
    gen.add_argument("--no-entrances", action="store_true", help="don't punch an entrance/exit into the border")
    args = parser.parse_args(argv)

    if (args.svg is None) == (args.generate is None):
        parser.error("specify either an SVG file OR --generate WxH")

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
            f.write(f"# Bias map {maze.cols}x{maze.rows}: digits 0-9, '.' = 1, 0 = blocked\n")
            for _ in range(maze.rows):
                f.write("." * maze.cols + "\n")
        print(f"Template written: {args.map_template} ({maze.cols}x{maze.rows})")
        return 0

    if args.preview:
        print_preview(maze)
        stats = tile_stats(maze)
        print("\nTile distribution:")
        for tile_name, count in stats.most_common():
            print(f"  {tile_name:10s} {count}")
        return 0

    try:
        tileset = TileSet.load(args.tiles)
    except TileLoadError as err:
        print(f"Error loading tiles: {err}", file=sys.stderr)
        print(
            "Tip: generate sample tiles with: python -m maze2schematic.make_default_tiles",
            file=sys.stderr,
        )
        return 1

    try:
        styles = assign_styles(maze, tileset, rng)
    except BiasMapError as err:
        print(f"Error in the bias map: {err}", file=sys.stderr)
        return 1

    if any(len(entries) > 1 for entries in tileset.variants.values()):
        print("Tile variants (weight/total):")
        print(tileset.describe())
        counts = style_stats(styles)
        parts = ", ".join(
            f"{style or 'default'}={n}" for style, n in counts.most_common()
        )
        print(f"Style distribution ({maze.rows * maze.cols} cells): {parts}")

    schem = assemble(
        maze, tileset, name=args.name, author=args.author, rng=rng, styles=styles,
        skip_closed=args.no_closed,
    )
    schem.save(args.out)

    ts = tileset.size
    print(
        f"OK: {maze.cols}x{maze.rows} cells, tile size {ts}x{tileset.height}x{ts} "
        f"-> {maze.cols * ts}x{tileset.height}x{maze.rows * ts} blocks"
    )
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
