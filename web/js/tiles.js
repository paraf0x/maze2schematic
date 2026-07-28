// Laedt Tile-Schematics (bereits als parseLitematic-Ergebnis vorliegend) und
// rotiert sie in 90-Grad-Schritten. Port von maze2schematic/tiles.py.
//
// Ein Tile wird als 3D-Array von BlockStates gehalten, indiziert [x][y][z]
// (Minecraft-Achsen: x = Ost, y = hoch, z = Sued). Norden ist -z; die SVG-Zeile 0
// liegt im fertigen Schematic bei z = 0.

import { AIR, stateKey } from "./litematic.js";
import { CANONICAL_MASKS } from "./classify.js";

export class TileError extends Error {}

// facing-Werte im Uhrzeigersinn
const _FACING_CW = { north: "east", east: "south", south: "west", west: "north" };
const _AXIS_CW = { x: "z", z: "x" };
// Verbindungs-Properties (Zaeune, Glasscheiben, Mauern, Redstone, Vines, ...)
const _SIDE_PROPS = ["north", "east", "south", "west"];
const _RAIL_SHAPE_CW = {
  north_south: "east_west",
  east_west: "north_south",
  ascending_north: "ascending_east",
  ascending_east: "ascending_south",
  ascending_south: "ascending_west",
  ascending_west: "ascending_north",
  north_east: "south_east",
  south_east: "south_west",
  south_west: "north_west",
  north_west: "north_east",
};

/** Rotiert einen BlockState um 90 Grad im Uhrzeigersinn (von oben gesehen). */
export function rotateStateCw(state) {
  const props = state.props;
  if (!props || Object.keys(props).length === 0) return state;
  const newProps = { ...props };

  if ("facing" in props && props.facing in _FACING_CW) {
    newProps.facing = _FACING_CW[props.facing];
  }
  if ("axis" in props && props.axis in _AXIS_CW) {
    newProps.axis = _AXIS_CW[props.axis];
  }
  if ("rotation" in props) {
    const n = Number.parseInt(props.rotation, 10);
    if (!Number.isNaN(n)) {
      newProps.rotation = String((((n + 4) % 16) + 16) % 16);
    }
  }
  if ("shape" in props && props.shape in _RAIL_SHAPE_CW) {
    newProps.shape = _RAIL_SHAPE_CW[props.shape];
  }
  if (_SIDE_PROPS.every((p) => p in props)) {
    const dsts = ["east", "south", "west", "north"];
    _SIDE_PROPS.forEach((src, i) => {
      newProps[dsts[i]] = props[src];
    });
  }

  return { id: state.id, props: newProps };
}

/** Port von Tile.rotated_cw: (x, z) -> (size-1-z, x), Nordkante wandert zur Ostkante. */
export function rotatedCw(tile) {
  const s = tile.size;
  const newBlocks = [];
  for (let x = 0; x < s; x++) {
    const plane = [];
    for (let y = 0; y < tile.height; y++) plane.push(new Array(s).fill(null));
    newBlocks.push(plane);
  }
  for (let x = 0; x < s; x++) {
    for (let y = 0; y < tile.height; y++) {
      for (let z = 0; z < s; z++) {
        newBlocks[s - 1 - z][y][x] = rotateStateCw(tile.blocks[x][y][z]);
      }
    }
  }
  return { name: tile.name, size: s, height: tile.height, blocks: newBlocks };
}

/** Port von _load_tile (tiles.py:88-113), operiert auf einem parseLitematic-Ergebnis. */
export function tileFromParsed(doc, name) {
  if (doc.regions.length !== 1) {
    throw new TileError(`${name}: erwartet genau 1 Region, gefunden ${doc.regions.length}.`);
  }
  const region = doc.regions[0];
  const sx = region.sizeX;
  const sy = region.sizeY;
  const sz = region.sizeZ;
  if (sx !== sz) {
    throw new TileError(`${name}: Grundflaeche muss quadratisch sein, ist ${sx}x${sz}.`);
  }

  const blocks = [];
  for (let x = 0; x < sx; x++) {
    const plane = [];
    for (let y = 0; y < sy; y++) {
      const row = [];
      for (let z = 0; z < sz; z++) row.push(region.get(x, y, z));
      plane.push(row);
    }
    blocks.push(plane);
  }
  return { name, size: sx, height: sy, blocks };
}

// Alternative Dateinamen je kanonischem Tile-Namen (presets/-Struktur)
export const ALIASES = {
  dead_end: ["dead_end", "deadend"],
  straight: ["straight"],
  turn: ["turn"],
  tee: ["tee", "tcross"],
  cross: ["cross", "xcross"],
  closed: ["closed"],
};

export const REQUIRED = ["dead_end", "straight", "turn", "tee", "cross"];

export const DEFAULT_STYLE = "";

/** Port von _style_of (tiles.py:149-156). */
export function styleOf(stem, alias) {
  if (stem === alias) return DEFAULT_STYLE;
  if (stem.startsWith(alias + "_")) return stem.slice(alias.length + 1);
  return stem;
}

// Sucht in der flachen Entry-Liste die Datei(en) fuer einen Tile-Typ; liefert
// { alias, matches }. Ersetzt das Dateisystem-Layout von _find_tile_files:
// im Web gibt es nur eine flache Liste von Dateien (Manifest oder Drag&Drop).
//
// Bevorzugt einen Alias, dessen Treffer eine DEFAULT_STYLE-Basis-Variante
// enthalten (z.B. "tcross.litematic" fuer den Alias "tcross"). Nur wenn
// KEIN Alias eine Basis-Variante liefert, wird auf den ersten Alias mit
// irgendeinem Treffer zurueckgefallen. Ohne diese Praeferenz wuerden sich
// gemischte Alias-Familien gegenseitig stoeren: z.B. wuerden die Dateien
// "tcross.litematic" (Basis fuer "tcross") und "tee_slim.litematic"
// (Style-Variante fuer "tee") sonst beide dem zuerst gelisteten Alias "tee"
// zugeordnet -- die gueltige "tcross"-Basis wuerde ignoriert und es kaeme zu
// einem verwirrenden TileError ("Basis-Variante fehlt"), obwohl eine Basis
// vorhanden ist (nur unter einem anderen Alias).
function findTileFiles(stemEntries, canonical) {
  let fallback = null;
  for (const alias of ALIASES[canonical]) {
    const matches = stemEntries
      .filter(({ stem }) => stem === alias || stem.startsWith(alias + "_"))
      .sort((a, b) => a.stem.localeCompare(b.stem));
    if (matches.length === 0) continue;
    const hasBase = matches.some(({ stem }) => styleOf(stem, alias) === DEFAULT_STYLE);
    if (hasBase) return { alias, matches };
    if (!fallback) fallback = { alias, matches };
  }
  if (fallback) return fallback;
  return { alias: canonical, matches: [] };
}

function mostCommonNonAirBlock(tile) {
  const counts = new Map(); // stateKey -> { state, count }
  for (let x = 0; x < tile.size; x++) {
    for (let y = 0; y < tile.height; y++) {
      for (let z = 0; z < tile.size; z++) {
        const state = tile.blocks[x][y][z];
        if (state.id === AIR.id) continue;
        const key = stateKey(state);
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { state, count: 1 });
      }
    }
  }
  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? best.state : AIR;
}

// Fehlt das optionale "closed"-Tile, wird eines synthetisiert: gleiche
// Grundflaeche/Hoehe wie das "straight"-Tile, komplett gefuellt mit dessen
// haeufigstem Nicht-Luft-Block (Spec "Fehlerbehandlung").
function synthesizeClosedTile(straightTile) {
  const fill = mostCommonNonAirBlock(straightTile);
  const blocks = [];
  for (let x = 0; x < straightTile.size; x++) {
    const plane = [];
    for (let y = 0; y < straightTile.height; y++) {
      plane.push(new Array(straightTile.size).fill(fill));
    }
    blocks.push(plane);
  }
  return { name: "closed", size: straightTile.size, height: straightTile.height, blocks };
}

export class TileSet {
  // variants[kanonischer Name][style] = [Tile, Gewicht]
  // clusters[style] = { minSize, maxSize }
  constructor(variants, clusters) {
    this.variants = variants;
    this.clusters = clusters;
    const firstTypeEntries = Object.values(variants)[0];
    const first = Object.values(firstTypeEntries)[0][0];
    this.size = first.size;
    this.height = first.height;
    this._cache = new Map();
  }

  static fromEntries(entries, config) {
    const weights = config?.weights ?? {};
    const clusters = config?.clusters ?? {};

    const stemEntries = entries.map(({ filename, doc }) => ({
      stem: filename.replace(/\.litematic$/i, ""),
      doc,
    }));

    const variants = {};
    for (const canonical of Object.keys(CANONICAL_MASKS)) {
      const { alias, matches } = findTileFiles(stemEntries, canonical);
      const styleEntries = {};
      for (const { stem, doc } of matches) {
        const weight = weights[stem] ?? 1;
        if (weight > 0) {
          styleEntries[styleOf(stem, alias)] = [tileFromParsed(doc, stem), weight];
        }
      }
      if (Object.keys(styleEntries).length > 0) {
        if (!(DEFAULT_STYLE in styleEntries)) {
          throw new TileError(
            `${alias}: Basis-Variante '${alias}.litematic' fehlt oder hat Gewicht 0.`,
          );
        }
        variants[canonical] = styleEntries;
      }
    }

    if (!("closed" in variants) && "straight" in variants) {
      const straightDefault =
        variants.straight[DEFAULT_STYLE]?.[0] ?? Object.values(variants.straight)[0][0];
      variants.closed = { [DEFAULT_STYLE]: [synthesizeClosedTile(straightDefault), 1] };
    }

    const missing = REQUIRED.filter((n) => !(n in variants));
    if (missing.length > 0) {
      throw new TileError(`Fehlende Tiles: ${missing.join(", ")}`);
    }

    const allTiles = [];
    for (const styleEntries of Object.values(variants)) {
      for (const [tile] of Object.values(styleEntries)) allTiles.push(tile);
    }
    const sizes = new Set(allTiles.map((t) => `${t.size}x${t.height}`));
    if (sizes.size !== 1) {
      const detail = allTiles.map((t) => `${t.name}=${t.size}x${t.height}x${t.size}`).join(", ");
      throw new TileError(`Alle Tiles muessen gleich gross sein: ${detail}`);
    }

    return new TileSet(variants, clusters);
  }

  /** Durchschnittliches Gewicht je Style ueber alle Tile-Typen. */
  styleWeights() {
    const sums = {};
    for (const styleEntries of Object.values(this.variants)) {
      for (const [style, [, weight]] of Object.entries(styleEntries)) {
        (sums[style] ??= []).push(weight);
      }
    }
    const out = {};
    for (const [style, weights] of Object.entries(sums)) {
      out[style] = weights.reduce((a, b) => a + b, 0) / weights.length;
    }
    return out;
  }

  /** Tile fuer Typ + Rotation + Style; unbekannter Style faellt auf den
   * Default zurueck (z.B. wenn ein Typ keine slim-Variante hat). */
  get(name, rotation, style = DEFAULT_STYLE) {
    const entries = this.variants[name];
    if (!(style in entries)) style = DEFAULT_STYLE;
    rotation = ((rotation % 4) + 4) % 4;
    const key = `${name} ${style} ${rotation}`;
    if (!this._cache.has(key)) {
      if (rotation === 0) {
        this._cache.set(key, entries[style][0]);
      } else {
        this._cache.set(key, rotatedCw(this.get(name, rotation - 1, style)));
      }
    }
    return this._cache.get(key);
  }
}
