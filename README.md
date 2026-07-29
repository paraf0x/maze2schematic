# maze2schematic

Builds a complete schematic for Minecraft from a maze and Litematica tile
schematics. The maze source is either an SVG (mazegenerator.net, "line
maze" format) or the built-in generator (a port of
[jsmaze](https://morgan3d.github.io/misc/jsmaze/) by Morgan McGuire, BSD
license).

## Web version

A static port runs entirely in the browser at
`https://paraf0x.github.io/maze2schematic/`: the generator, tile assembly,
and export all run client-side as JavaScript, no server required (other
than to serve the static files). Presets, 2D/3D preview, and the
Litematica export (`.litematic`, gzip-compressed) work without Python or
any installation.

The web presets under `web/presets/` are a copy of `presets/`; after
changes to `presets/` (new tiles, `variants.json`), rerun

```bash
.venv/bin/python scripts/make_web_presets.py
```

to update `web/presets/` and its `index.json`.

Run locally (from the repo root, so both the root `index.html` and
`web/` are reachable):

```bash
python3 -m http.server 8080
```

then open <http://localhost:8080/web/> in your browser. Alternatively,
serve `web/` directly as the docroot:

```bash
python3 -m http.server 8080 -d web
```

Tests run with Node (no build step needed):

```bash
node --test web/test/*.test.js
```

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Usage

```bash
# 1. (Optional) generate sample tiles if you don't have your own yet
.venv/bin/python -m maze2schematic.make_default_tiles tiles

# 2. Preview: check the detected maze as ASCII
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --preview

# 3. Build the schematic
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --tiles tiles -o maze.litematic

# Alternative: generate a maze instead of an SVG (jsmaze algorithm)
.venv/bin/python -m maze2schematic --generate 20x20 --tiles presets -o maze.litematic
.venv/bin/python -m maze2schematic --generate 30x20 --dungeon catacombs --seed 7 --tiles presets -o dungeon.litematic
```

Further options: `--name`, `--author` for the schematic metadata, and
`--seed` for reproducible generation and variant selection (see below).

## Generator (jsmaze)

`--generate COLSxROWS` generates the maze directly (algorithm from
[jsmaze](https://morgan3d.github.io/misc/jsmaze/)). Parameters:

- `--straightness 0..1`: prefers straight corridors
- `--shortcuts 0..1`: extra connections, creates loops (0 = a perfect maze
  with a unique solution)
- `--coverage 0..1`: how much of the area is carved out; at < 1, solid
  areas remain (closed tiles)
- `--rooms 0..1`: fraction of dead ends expanded into rooms
- `--h-loop` / `--v-loop`: wraparound (torus); corridors end open at the
  border, useful when the schematic is tiled
- `--h-mirror` / `--v-mirror`: mirror symmetry (solvability not guaranteed)
- `--no-h-border` / `--no-v-border`: without an outer wall
- `--no-entrances`: don't punch an entrance/exit into the top/bottom border
- `--no-closed`: leave closed cells empty (air) instead of placing the
  closed tile; also the automatic behavior when the tile set has no closed
  tile (in the web app: disable the closed tile in the tile manager)
- `--dungeon NAME`: parameter presets from the jsmaze website
  (labyrinth, catacombs, hedge, palace, fortress, suburb, city, pacman,
  starship, garden, forbidden); individual options override the preset

Notes: the actual size may deviate slightly depending on the options (the
algorithm rounds). In the original, rooms can remove wall posts; in the
tile model the posts of the cross tiles remain standing as pillars --
rooms therefore become pillared halls. Fully closed cells use the closed
tile (completely solid).

## SVG format

The expected format is the "line maze" format from
[mazegenerator.net](https://www.mazegenerator.net/): the polylines are
the **walkable paths** (not the walls) and connect the centers of
neighboring cells. Entrances/exits are short stubs extending past the
border. Cell size and grid extent are detected automatically, so the
maze size is arbitrary.

## Tile conventions

The tiles folder supports two layouts:

- flat: `tiles/straight.litematic`, `tiles/tee.litematic`, ...
- subfolders (presets): `presets/straight/*.litematic`, `presets/tcross/*.litematic`, ...
  Each `.litematic` file in the subfolder is a **variant** of the tile
  type, chosen randomly per cell. The aliases `tcross` (= tee), `xcross`
  (= cross), and `deadend` (= dead_end) are also allowed as folder names.

Each tile has exactly one region, a square footprint (e.g. 5x5), and all
tiles must have the same size and height. The tile size is read from the
files, so 5x5 isn't hardcoded.

### Variant configuration (`variants.json`)

An optional `variants.json` in the tiles folder controls the weights and
cluster behavior of the variants:

```json
{
  "weights": {
    "straight": 3,
    "straight_slim": 1
  },
  "clusters": {
    "slim": { "min": 3, "max": 8, "map": "slim_map.txt" }
  }
}
```

- `weights`: the key is the filename without `.litematic`. Variants not
  listed have weight 1, weight 0 disables a variant. The weights
  determine the area share per variant.
- `clusters`: variants are grouped into a "style" via their name suffix
  (`straight_slim` + `turn_slim` + ... = style `slim`). A cluster entry
  makes that style occur in connected areas of `min` to `max` cells along
  the corridors instead of being scattered individually. Without an
  entry, cells are rolled individually.
- `map` (optional): a bias map controlling **where** a style's clusters
  form. Path relative to the tiles folder; without `map` the distribution
  is uniformly random.

With `--seed <number>` the distribution is reproducible.

### Bias map

A bias map is a text grid sized to the maze: one line per maze row, one
character per cell. Digit `0`-`9` = weight of the cell, `.` = 1, `0`
blocks the cell entirely. Lines starting with `#` are comments. Seeds and
cluster growth prefer cells with a high weight; the style's overall share
is still determined by `weights`.

Generate an empty template of the matching size:

```bash
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --map-template presets/slim_map.txt
```

Example (top half blocked, bottom allowed, bottom-right preferred):

```
00000000000000000000
00000000000000000000
...
11112222333344445555
33344445555666677778
```

Only **one** file in canonical orientation is needed per type; the tool
generates all rotations itself (including block states like `facing`,
`axis`, `rotation`, rail `shape`, and connection properties of
fences/panes/walls).

| File | open sides (canonical) | required |
| --- | --- | --- |
| `dead_end.litematic` | north | yes |
| `straight.litematic` | north + south | yes |
| `turn.litematic` | north + east | yes |
| `tee.litematic` | east + south + west (closed: north) | yes |
| `cross.litematic` | all four | yes |
| `closed.litematic` | none | optional |

"North" in a tile = the -Z direction in Litematica; in the finished
schematic the topmost SVG row faces -Z. For the paths to line up, the
openings at the edges should be at the same positions across all tiles
(in the sample tiles: the middle 3-cell strip of each edge).

Notes:

- Tile entities (chests, signs, ...) in tiles are currently ignored
  (a warning is printed when loading).
- Walls between two tiles are twice as thick as a tile's border wall,
  since each tile brings its own border.

## Project structure

- `maze2schematic/svg_parser.py` - SVG to a cell grid with open directions
- `maze2schematic/generate.py` - jsmaze port (generator instead of SVG)
- `maze2schematic/classify.py` - cell mask to tile type + rotation
- `maze2schematic/tiles.py` - tile loader and 90-degree rotator
- `maze2schematic/assemble.py` - assembles the complete schematic
- `maze2schematic/make_default_tiles.py` - generates simple sample tiles
- `maze2schematic/make_presets.py` - generates the presets/ structure (wide + slim variants, variants.json)
- `maze2schematic/__main__.py` - CLI
