# maze2schematic-web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Statische GitHub-Pages-Seite, die den maze2schematic-Python-Pipeline (jsmaze-Generator → Tile-Assembly → `.litematic`-Export) komplett client-seitig nachbildet, mit 2D-, Top-Down- und 3D-Vorschau und Upload eigener Tiles.

**Architecture:** Vanilla-JS-ES-Module in `web/js/`, UI-frei gehaltene Kern-Module (in Node testbar mit `node --test`), three.js vendort. Die Python-Module `generate.py`, `classify.py`, `tiles.py`, `assemble.py` sind die Referenz-Implementierung und liegen im selben Repo — Ports müssen deren Semantik exakt erhalten. Spec: `docs/superpowers/specs/2026-07-28-maze2schematic-web-design.md`.

**Tech Stack:** Vanilla JS (ES modules), Canvas 2D, three.js (vendort), native `CompressionStream`/`DecompressionStream`, `node --test` für Tests (Node ≥ 18).

## Global Constraints

- Kein Build-Schritt, keine npm-Dependencies zur Laufzeit. `web/` muss direkt von GitHub Pages ausliefbar sein.
- Kern-Module (`rng`, `generate`, `classify`, `nbt`, `litematic`, `tiles`, `variants`, `assemble`) importieren nie DOM/three.js — sie müssen in Node laufen.
- Richtungs-Konstanten überall: `N=0, E=1, S=2, W=3` (im Uhrzeigersinn — Rotationslogik hängt daran).
- Maze-Datenmodell überall: `{rows, cols, masks}` mit `masks[row][col] = Set<number>` offener Richtungen.
- BlockState-Datenmodell überall: `{id: string, props: Object<string,string>}`; Luft = `{id: "minecraft:air", props: {}}`. Palette-Schlüssel: `id + JSON.stringify(props mit sortierten Keys)`.
- Litematic-Export-Header exakt: `Version=6`, `SubVersion=1`, `MinecraftDataVersion=2975` (identisch zu dem, was litemapy heute schreibt; verifiziert an `maze.litematic`).
- Tests laufen mit `node --test web/test/` aus dem Repo-Root.
- Commits: konventioneller Stil wie bisher im Repo, Co-Authored-By-Trailer.

## File Structure

```text
web/
  index.html            # Task 10
  css/style.css         # Task 10
  js/
    rng.js              # Task 1  – seedbarer PRNG (mulberry32) + Helpers
    generate.js         # Task 2  – Port von generate.py
    classify.js         # Task 3  – Port von classify.py
    nbt.js              # Task 4  – NBT lesen/schreiben (DataView)
    litematic.js        # Task 5  – .litematic parse/write + Long-Bitpacking
    tiles.js            # Task 6  – Tile, Rotation, TileSet
    variants.js         # Task 6  – variants.json-Parsing (weights/clusters)
    assemble.js         # Task 7  – Style-Cluster + Blockgitter-Assembly
    export.js           # Task 8  – gzip/gunzip + Blob-Download
    main.js             # Task 10 – UI-State und Verdrahtung
    preview2d.js        # Task 11 – Maze-Linien + Top-Down-Canvas
    preview3d.js        # Task 12 – three.js Voxel-Ansicht
  vendor/
    three.module.js     # Task 12 (vendort)
    OrbitControls.js    # Task 12 (vendort)
  presets/              # Task 9  – Kopie von presets/ + index.json-Manifest
  test/
    rng.test.js         # Task 1
    generate.test.js    # Task 2
    classify.test.js    # Task 3
    nbt.test.js         # Task 4
    litematic.test.js   # Task 5
    tiles.test.js       # Task 6
    assemble.test.js    # Task 7
    export.test.js      # Task 8
    crosscheck.py       # Task 13 – liest Web-Export mit litemapy
scripts/
  make_web_presets.py   # Task 9  – kopiert presets/ nach web/presets/ + Manifest
index.html              # Task 13 – Root-Redirect auf web/
```

---

### Task 1: Seedbarer PRNG (`rng.js`) + Test-Setup

**Files:**
- Create: `web/js/rng.js`
- Test: `web/test/rng.test.js`

**Interfaces:**
- Produces: `makeRng(seed)` → Objekt mit:
  - `random()` → Float in [0,1) (wie `Math.random`)
  - `randInt(x)` → `Math.floor(random() * x)` (jsmaze-Konvention, akzeptiert Float-Argument)
  - `randRange(n)` → Ganzzahl in [0, n) (wie Python `randrange`)
  - `randIntRange(a, b)` → Ganzzahl in [a, b] inklusiv (wie Python `randint`)
  - `choice(arr)` → zufälliges Element
  - `shuffle(arr)` → in-place Fisher-Yates (wie `shuffle()` in generate.py:100-103)
  - `weightedIndex(weights)` → Index proportional zu `weights[i]` (wie `random.choices(range(n), weights)[0]`)
- Seed ist eine beliebige Ganzzahl; gleicher Seed ⇒ gleiche Sequenz. Muss NICHT mit Python übereinstimmen (siehe Spec).

- [ ] **Step 1: Failing Test schreiben**

```js
// web/test/rng.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../js/rng.js";

test("gleicher Seed liefert gleiche Sequenz", () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.random(), b.random());
});

test("random() liegt in [0,1)", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r.random();
    assert.ok(v >= 0 && v < 1);
  }
});

test("randRange/randIntRange/choice respektieren Grenzen", () => {
  const r = makeRng(1);
  for (let i = 0; i < 1000; i++) {
    assert.ok(r.randRange(5) >= 0 && r.randRange(5) < 5);
    const v = r.randIntRange(2, 4);
    assert.ok(v >= 2 && v <= 4);
  }
  assert.ok([1, 2, 3].includes(r.choice([1, 2, 3])));
});

test("shuffle permutiert in-place", () => {
  const r = makeRng(3);
  const arr = [1, 2, 3, 4, 5];
  r.shuffle(arr);
  assert.deepEqual([...arr].sort(), [1, 2, 3, 4, 5]);
});

test("weightedIndex respektiert Nullgewichte", () => {
  const r = makeRng(9);
  for (let i = 0; i < 200; i++) {
    assert.equal(r.weightedIndex([0, 1, 0]), 1);
  }
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag verifizieren**

Run: `node --test web/test/rng.test.js`
Expected: FAIL (Cannot find module `../js/rng.js`)

- [ ] **Step 3: Implementierung**

```js
// web/js/rng.js
// Seedbarer PRNG (mulberry32). Gleicher Seed => gleiche Sequenz.
export function makeRng(seed) {
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const randInt = (x) => Math.floor(random() * x);
  const randRange = (n) => Math.floor(random() * n);
  const randIntRange = (a, b) => a + Math.floor(random() * (b - a + 1));
  const choice = (arr) => arr[randRange(arr.length)];
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  function weightedIndex(weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
  return { random, randInt, randRange, randIntRange, choice, shuffle, weightedIndex };
}
```

- [ ] **Step 4: Test laufen lassen, PASS verifizieren**

Run: `node --test web/test/rng.test.js`
Expected: alle Tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/js/rng.js web/test/rng.test.js
git commit -m "feat(web): seedbarer PRNG (mulberry32) mit Python-artigen Helpers"
```

---

### Task 2: Generator-Port (`generate.js`)

**Files:**
- Create: `web/js/generate.js`
- Test: `web/test/generate.test.js`
- Referenz (lesen, nicht ändern): `maze2schematic/generate.py`, `maze2schematic/svg_parser.py:17-26`

**Interfaces:**
- Consumes: `makeRng(seed)` aus Task 1.
- Produces:
  - `export const N = 0, E = 1, S = 2, W = 3;`
  - `export const DUNGEON_PRESETS` — gleiche Namen und Tupel-Werte wie `generate.py:46-58`, als `{name: {hloop, vloop, hborder, vborder, hmirror, vmirror, shortcuts, straightness, coverage, rooms}}`.
  - `export function defaultOptions()` → `{cols: 20, rows: 20, straightness: 0, shortcuts: 0, coverage: 1, rooms: 0, horizontal: {loop: false, mirror: false, border: 1}, vertical: {loop: false, mirror: false, border: 1}, entrances: true}`
  - `export function presetOptions(name, cols, rows)` → wie `preset_options()` (generate.py:61-72)
  - `export function generateMaze(opts, rng)` → `{rows, cols, masks}` mit `masks[row][col] = Set<number>` — exakt die Semantik von `generate_maze()` (generate.py:371-405)

**Vorgehen:** `generate.py` ist selbst schon ein Port aus JavaScript (jsmaze) — die Rückportierung ist mechanisch. Alle vier Funktionen 1:1 übertragen: `_make_maze` (Z.75-297), `_add_rooms` (Z.300-335), `_lattice_to_maze` (Z.338-368), `generate_maze` (Z.371-405). Funktionsstruktur, Variablennamen und Kommentare beibehalten (deutsch ok), damit Code-Review gegen die Python-Datei diffbar bleibt.

**JS-Fallstricke, die den Port sonst still korrumpieren:**

| Python | JS | Achtung |
| --- | --- | --- |
| `w += ~(w & 1)` | `w += ~(w & 1)` | identisch — `~0 == -1`, `~1 == -2`; NICHT "vereinfachen" |
| `round(x)` | `Math.round(x)` | Python rundet .5 zu gerade, JS immer auf — bei `round((w-2)/4)*4+2` (Z.120/128) nur relevant wenn `(w-2)/4` exakt .5 endet; jsmaze-Original nutzt `Math.round`, also ist `Math.round` hier KORREKT (das Original ist die Referenz) |
| `w // 4` | `Math.floor(w / 4)` | für negative Werte verschieden, hier nur positive |
| `maze = [[SOLID]*h for _ in range(w)]` | `Array.from({length: w}, () => new Array(h).fill(SOLID))` | maze ist **spaltenweise** indiziert: `maze[x][y]` |
| `directions[i] is step` | `directions[i] === step` | Identitätsvergleich auf dem Richtungs-**Objekt**: Richtungen als konstante Array-Referenzen `const DIRECTIONS = [[-1,0],[1,0],[0,1],[0,-1]]` einmal anlegen; `step` ist immer eine dieser Referenzen (oder `START_STEP = [0,0]`); shuffle vertauscht nur Referenzen |
| `for step_dir in list(directions)` | `for (const stepDir of [...directions])` | Kopie, weil `directions` global geshuffelt wird |
| `stack.pop()` | `stack.pop()` | LIFO, identisch |
| `maze[-1][y]` | `maze[w - 1][y]` | negative Indizes ausschreiben; ebenso `col[-1]`, `maze[x][-1]` |
| `maze.pop(0)` | `maze.shift()` | vorn entfernen |
| `dead_ends[:] = [...]` | `deadEnds.length = 0; deadEnds.push(...filtered)` | in-place, da Aufrufer die Referenz hält |
| `set()` / `mask.add(d)` | `new Set()` / `mask.add(d)` | identisch |
| `rng.choice(top)` (Z.401) | `rng.choice(top)` | Task-1-API |
| `math.ceil` / `math.floor` | `Math.ceil` / `Math.floor` | identisch |

- [ ] **Step 1: Failing Tests schreiben**

```js
// web/test/generate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../js/rng.js";
import { N, E, S, W, generateMaze, defaultOptions, presetOptions, DUNGEON_PRESETS } from "../js/generate.js";

function opts(over = {}) { return { ...defaultOptions(), ...over }; }

test("Default 20x20: exakte Groesse, Rand zu, genau 1 Eingang oben + 1 unten", () => {
  const m = generateMaze(opts(), makeRng(1));
  assert.equal(m.cols, 20);
  assert.equal(m.rows, 20);
  let top = 0, bottom = 0;
  for (let c = 0; c < m.cols; c++) {
    if (m.masks[0][c].has(N)) top++;
    if (m.masks[m.rows - 1][c].has(S)) bottom++;
  }
  assert.equal(top, 1);
  assert.equal(bottom, 1);
  // Seitenraender komplett zu
  for (let r = 0; r < m.rows; r++) {
    assert.ok(!m.masks[r][0].has(W));
    assert.ok(!m.masks[r][m.cols - 1].has(E));
  }
});

test("Masken sind symmetrisch: Osten offen <=> Nachbar Westen offen", () => {
  const m = generateMaze(opts({ shortcuts: 0.5, coverage: 0.5, rooms: 0.5 }), makeRng(2));
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols - 1; c++) {
      assert.equal(m.masks[r][c].has(E), m.masks[r][c + 1].has(W), `bei ${r},${c}`);
    }
  }
  for (let r = 0; r < m.rows - 1; r++) {
    for (let c = 0; c < m.cols; c++) {
      assert.equal(m.masks[r][c].has(S), m.masks[r + 1][c].has(N), `bei ${r},${c}`);
    }
  }
});

test("Perfektes Maze (shortcuts=0, coverage=1): alle Zellen erreichbar", () => {
  const m = generateMaze(opts({ entrances: false }), makeRng(3));
  const seen = new Set();
  const stack = [[0, 0]];
  // Startzelle: erste offene Zelle suchen
  outer: for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
    if (m.masks[r][c].size) { stack[0] = [r, c]; break outer; }
  }
  while (stack.length) {
    const [r, c] = stack.pop();
    const key = r * m.cols + c;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const d of m.masks[r][c]) {
      const nr = r + (d === S ? 1 : 0) - (d === N ? 1 : 0);
      const nc = c + (d === E ? 1 : 0) - (d === W ? 1 : 0);
      if (nr >= 0 && nr < m.rows && nc >= 0 && nc < m.cols) stack.push([nr, nc]);
    }
  }
  let open = 0;
  for (const row of m.masks) for (const mask of row) if (mask.size) open++;
  assert.equal(seen.size, open);
  assert.equal(open, m.rows * m.cols); // coverage=1: alles ausgegraben
});

test("Reproduzierbar: gleicher Seed, gleiches Maze", () => {
  const a = generateMaze(opts({ shortcuts: 0.3, rooms: 0.4 }), makeRng(7));
  const b = generateMaze(opts({ shortcuts: 0.3, rooms: 0.4 }), makeRng(7));
  assert.deepEqual(
    a.masks.map((row) => row.map((s) => [...s].sort())),
    b.masks.map((row) => row.map((s) => [...s].sort())),
  );
});

test("Presets vorhanden und presetOptions setzt Werte", () => {
  const names = ["labyrinth", "catacombs", "hedge", "palace", "fortress",
    "suburb", "city", "pacman", "starship", "garden", "forbidden"];
  assert.deepEqual(Object.keys(DUNGEON_PRESETS).sort(), [...names].sort());
  const o = presetOptions("catacombs", 30, 20);
  assert.equal(o.coverage, 0.2);
  assert.equal(o.rooms, 1.0);
  assert.equal(o.cols, 30);
});

test("Alle Presets laufen fehlerfrei in mehreren Groessen", () => {
  for (const name of Object.keys(DUNGEON_PRESETS)) {
    for (const [c, r] of [[10, 10], [21, 13], [30, 20]]) {
      const m = generateMaze(presetOptions(name, c, r), makeRng(5));
      assert.ok(m.rows > 0 && m.cols > 0, name);
    }
  }
});
```

- [ ] **Step 2: Fehlschlag verifizieren**

Run: `node --test web/test/generate.test.js`
Expected: FAIL (Modul fehlt)

- [ ] **Step 3: Port schreiben**

`web/js/generate.js` anlegen: Konstanten `SOLID = 255, RESERVED = 127, EMPTY = 0`, dann die vier Funktionen exakt nach `maze2schematic/generate.py` übertragen (Zeilenangaben und Fallstrick-Tabelle oben). Export-Signaturen aus dem Interfaces-Block. `AxisOptions`/`GenerateOptions` werden zu plain objects (`defaultOptions()`), `DUNGEON_PRESETS` als Objekt-Literal mit denselben zehn Feldern pro Eintrag.

- [ ] **Step 4: Tests laufen lassen**

Run: `node --test web/test/generate.test.js`
Expected: alle PASS. Falls der Erreichbarkeits-Test scheitert: zuerst `directions`-Identität (`===` auf Referenz) und die `set_cell`-Symmetrielogik gegen generate.py:158-169 diffen.

- [ ] **Step 5: Manueller Spiegelvergleich mit Python**

Run (ASCII-Vorschau Python): `.venv/bin/python -m maze2schematic --generate 20x20 --seed 3 --preview`
Und ein Wegwerf-Node-Skript, das das JS-Maze als ASCII druckt (gleiches Format: pro Zelle `+--+`-Raster). Die Mazes sind NICHT identisch (anderer PRNG) — geprüft wird nur, dass beide plausibel aussehen (zusammenhängende Gänge, Rand zu). Wegwerf-Skript danach löschen.

- [ ] **Step 6: Commit**

```bash
git add web/js/generate.js web/test/generate.test.js
git commit -m "feat(web): jsmaze-Generator-Port (generate.js) mit Invarianten-Tests"
```

---

### Task 3: Klassifizierung (`classify.js`)

**Files:**
- Create: `web/js/classify.js`
- Test: `web/test/classify.test.js`
- Referenz: `maze2schematic/classify.py`

**Interfaces:**
- Consumes: `N, E, S, W` aus `generate.js`.
- Produces:
  - `export const TILE_NAMES = ["closed", "dead_end", "straight", "turn", "tee", "cross"];`
  - `export function classify(mask)` — `mask` ist `Set<number>`, Rückgabe `{name: string, rotation: number}` (Rotation 0..3 im Uhrzeigersinn), Semantik wie `classify()` (classify.py:43-45): kanonische Masken classify.py:18-25, bei Mehrdeutigkeit kleinste Rotation.

- [ ] **Step 1: Failing Test — alle 16 Masken explizit**

```js
// web/test/classify.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { N, E, S, W } from "../js/generate.js";
import { classify } from "../js/classify.js";

// Erwartungswerte aus classify.py abgeleitet: kanonisch + kleinste Rotation.
const CASES = [
  [[], "closed", 0],
  [[N], "dead_end", 0], [[E], "dead_end", 1], [[S], "dead_end", 2], [[W], "dead_end", 3],
  [[N, S], "straight", 0], [[E, W], "straight", 1],
  [[N, E], "turn", 0], [[E, S], "turn", 1], [[S, W], "turn", 2], [[N, W], "turn", 3],
  [[E, S, W], "tee", 0], [[N, S, W], "tee", 1], [[N, E, W], "tee", 2], [[N, E, S], "tee", 3],
  [[N, E, S, W], "cross", 0],
];

test("alle 16 Masken werden korrekt klassifiziert", () => {
  for (const [dirs, name, rotation] of CASES) {
    assert.deepEqual(classify(new Set(dirs)), { name, rotation }, `Maske {${dirs}}`);
  }
});
```

- [ ] **Step 2: Fehlschlag verifizieren**

Run: `node --test web/test/classify.test.js` — Expected: FAIL

- [ ] **Step 3: Implementierung**

```js
// web/js/classify.js
// Port von maze2schematic/classify.py — Maske (offene Richtungen) -> Tile + Rotation.
import { N, E, S, W } from "./generate.js";

export const CANONICAL_MASKS = {
  closed: [],
  dead_end: [N],
  straight: [N, S],
  turn: [N, E],
  tee: [E, S, W],
  cross: [N, E, S, W],
};

export const TILE_NAMES = Object.keys(CANONICAL_MASKS);

export function rotateMask(dirs, times) {
  return dirs.map((d) => (d + times) % 4);
}

const maskKey = (dirs) => [...dirs].sort().join(",");

const LOOKUP = new Map();
for (const [name, canonical] of Object.entries(CANONICAL_MASKS)) {
  for (let r = 0; r < 4; r++) {
    const key = maskKey(rotateMask(canonical, r));
    if (!LOOKUP.has(key)) LOOKUP.set(key, { name, rotation: r });
  }
}

export function classify(mask) {
  return LOOKUP.get(maskKey(mask));
}
```

- [ ] **Step 4: Tests laufen lassen** — `node --test web/test/classify.test.js`, Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/js/classify.js web/test/classify.test.js
git commit -m "feat(web): Zellmasken-Klassifizierung (classify.js)"
```

---

### Task 4: NBT lesen/schreiben (`nbt.js`)

**Files:**
- Create: `web/js/nbt.js`
- Test: `web/test/nbt.test.js`

**Interfaces:**
- Produces:
  - `export function readNbt(uint8)` → `{name: string, value: Object}` — liest **unkomprimierte** Big-Endian-NBT-Bytes; Wurzel ist immer ein Compound.
  - `export function writeNbt(name, value)` → `Uint8Array` (unkomprimiert).
  - Werte-Modell (getypte Wrapper, damit der Writer den Tag-Typ kennt):
    - `export const tag = { byte(n), short(n), int(n), long(bigint), float(n), double(n), string(s), byteArray(int8arr), intArray(int32arr), longArray(bigint64arr), list(tagType, valuesArray), compound(obj) }` — jedes liefert `{type: <TAG-ID>, value}`.
    - Tag-IDs als Konstanten: `export const TAG = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };`
  - `readNbt` liefert dieselben Wrapper zurück (Roundtrip-fähig): Compound-`value` ist `{key: {type, value}}`, List-`value` ist `{elemType, items: [...]}`.
- Gzip ist NICHT Teil dieses Moduls (Task 8).

**Format-Referenz (Big-Endian):** Jedes benannte Tag: `[typeByte][nameLen:u16][nameUtf8][payload]`. Compound: Folge benannter Tags bis `TAG_END` (0x00). List: `[elemType:u8][count:i32][payloads...]`. String: `[len:u16][utf8]` (Java "modified UTF-8" — für unsere Inhalte, ASCII-Blocknamen und Metadaten, ist Standard-UTF-8 via `TextEncoder`/`TextDecoder` ausreichend). Long: `BigInt` über `DataView.getBigInt64/setBigInt64`. Arrays: `[count:i32][elemente]`.

- [ ] **Step 1: Failing Tests schreiben**

```js
// web/test/nbt.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { readNbt, writeNbt, tag, TAG } from "../js/nbt.js";

test("Roundtrip eines handgebauten Compounds", () => {
  const root = tag.compound({
    Version: tag.int(6),
    Name: tag.string("maze"),
    Time: tag.long(1785228778445n),
    Vals: tag.list(TAG.INT, [tag.int(1), tag.int(2), tag.int(3)]),
    States: tag.longArray(new BigInt64Array([1n, -2n, 3n])),
    Nested: tag.compound({ x: tag.double(1.5), b: tag.byte(-1) }),
  });
  const bytes = writeNbt("", root);
  const back = readNbt(bytes);
  assert.equal(back.name, "");
  assert.equal(back.value.value.Version.value, 6);
  assert.equal(back.value.value.Name.value, "maze");
  assert.equal(back.value.value.Time.value, 1785228778445n);
  assert.deepEqual(back.value.value.Vals.value.items.map((t) => t.value), [1, 2, 3]);
  assert.deepEqual([...back.value.value.States.value], [1n, -2n, 3n]);
  assert.equal(back.value.value.Nested.value.x.value, 1.5);
  assert.equal(back.value.value.Nested.value.b.value, -1);
});

test("liest eine echte litemapy-Datei", () => {
  const raw = gunzipSync(readFileSync("maze.litematic"));
  const { value: root } = readNbt(new Uint8Array(raw));
  assert.equal(root.value.Version.value, 6);
  assert.equal(root.value.SubVersion.value, 1);
  assert.equal(root.value.MinecraftDataVersion.value, 2975);
  assert.ok(root.value.Regions.value.maze);
});

test("Byte-identischer Roundtrip der echten Datei", () => {
  const raw = new Uint8Array(gunzipSync(readFileSync("maze.litematic")));
  const { name, value } = readNbt(raw);
  const out = writeNbt(name, value);
  assert.deepEqual([...out], [...raw]);
});
```

- [ ] **Step 2: Fehlschlag verifizieren** — `node --test web/test/nbt.test.js`, Expected: FAIL

- [ ] **Step 3: Implementierung**

`web/js/nbt.js`: Reader als Cursor über `DataView` (`pos` hochzählen), Writer sammelt Chunks in ein Array und konkateniert am Ende in eine `Uint8Array` (Größe vorher aufsummieren). Für jeden Tag-Typ eine `readPayload(type)`/`writePayload(type, value)`-Verzweigung; Compound liest bis TAG_END; List liest `elemType` + `count` und erzeugt `{elemType, items}`. Strings via `TextEncoder`/`TextDecoder("utf-8")`. Long/LongArray strikt als `BigInt`/`BigInt64Array`. Float via `getFloat32`, Double via `getFloat64`.

- [ ] **Step 4: Tests laufen lassen** — Expected: alle PASS, insbesondere der byte-identische Roundtrip.

- [ ] **Step 5: Commit**

```bash
git add web/js/nbt.js web/test/nbt.test.js
git commit -m "feat(web): NBT-Reader/-Writer mit byte-identischem Roundtrip"
```

---

### Task 5: Litematic-Format (`litematic.js`)

**Files:**
- Create: `web/js/litematic.js`
- Test: `web/test/litematic.test.js`
- Referenz: NBT-Struktur siehe unten (verifiziert an `maze.litematic` aus litemapy 0.11.0b0)

**Interfaces:**
- Consumes: `readNbt`, `writeNbt`, `tag`, `TAG` aus Task 4; BlockState-Modell `{id, props}` (Global Constraints).
- Produces:
  - `export function stateKey(state)` → `state.id + "|" + JSON.stringify(Object.fromEntries(Object.entries(state.props).sort()))` — Palette-Schlüssel.
  - `export const AIR = Object.freeze({ id: "minecraft:air", props: {} });`
  - `export function parseLitematic(uint8)` — nimmt **unkomprimierte** NBT-Bytes, liefert `{name, author, description, regions: [{name, sizeX, sizeY, sizeZ, get(x, y, z)}], warnings: [string]}`. `get` liefert `{id, props}`; Koordinaten sind 0-basiert und normalisiert (negative Size wie in litemapy: Region kann negative Ausdehnung haben — normalisieren zu `abs`, Ursprung an die Min-Ecke; genau wie `sorted(region.range_x())` in tiles.py:107-109). `warnings` enthält je Region mit Tile-Entities einen Eintrag.
  - `export function writeLitematic({name, author, description = "", sizeX, sizeY, sizeZ, palette, blocks, timestamp})` → `Uint8Array` (unkomprimiert; gzip macht Task 8). `palette` = Array von BlockStates, Index 0 MUSS Luft sein; `blocks` = `Uint32Array` der Länge `sizeX*sizeY*sizeZ` mit Palette-Indizes, Index-Reihenfolge `(y * sizeZ + z) * sizeX + x`. `timestamp` (ms, Number) wird als `TimeCreated`/`TimeModified` geschrieben.

**Struktur des Root-Compounds (exakt so schreiben):**

```text
Version: Int 6, SubVersion: Int 1, MinecraftDataVersion: Int 2975
Metadata: { EnclosingSize: {x,y,z: Int}, Author: String, Description: String,
            Name: String, Software: String "maze2schematic-web",
            RegionCount: Int 1, TimeCreated/TimeModified: Long,
            TotalBlocks: Int (Anzahl nicht-Luft-Blöcke), TotalVolume: Int (x*y*z),
            PreviewImageData: IntArray len=0 }
Regions: { <name>: { Position: {x:0,y:0,z:0}, Size: {x,y,z},
            BlockStatePalette: List[Compound] — je Eintrag {Name: String, Properties?: Compound aus String-Tags},
            Entities: List[Compound] leer, TileEntities: List[Compound] leer,
            PendingBlockTicks: List[Compound] leer, PendingFluidTicks: List[Compound] leer,
            BlockStates: LongArray } }
```

**Bit-Packing (`BlockStates`):** `bits = Math.max(2, Math.ceil(Math.log2(palette.length)))`. Indizes werden als **durchgehender little-endian-Bitstrom** in signierte 64-bit-Longs gepackt — Einträge dürfen Long-Grenzen überspannen (Litematica-Format, NICHT das 1.16-Chunk-Format mit Padding). Implementierung mit `BigInt`:

```js
function packBlockStates(indices, bits) {
  const totalBits = BigInt(indices.length) * BigInt(bits);
  const longCount = Number((totalBits + 63n) / 64n);
  const longs = new BigInt64Array(longCount);
  let bitPos = 0n;
  for (const idx of indices) {
    const li = Number(bitPos / 64n);
    const off = bitPos % 64n;
    longs[li] = BigInt.asIntN(64, longs[li] | (BigInt(idx) << off));
    const spill = off + BigInt(bits) - 64n;
    if (spill > 0n) {
      longs[li + 1] = BigInt.asIntN(64, BigInt(idx) >> (BigInt(bits) - spill));
    }
    bitPos += BigInt(bits);
  }
  return longs;
}

function unpackBlockStates(longs, bits, count) {
  const out = new Uint32Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  let bitPos = 0n;
  for (let i = 0; i < count; i++) {
    const li = Number(bitPos / 64n);
    const off = bitPos % 64n;
    let v = BigInt.asUintN(64, longs[li]) >> off;
    const spill = off + BigInt(bits) - 64n;
    if (spill > 0n) {
      v |= BigInt.asUintN(64, longs[li + 1]) << (BigInt(bits) - spill);
    }
    out[i] = Number(v & mask);
    bitPos += BigInt(bits);
  }
  return out;
}
```

- [ ] **Step 1: Failing Tests schreiben**

```js
// web/test/litematic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseLitematic, writeLitematic, stateKey, AIR } from "../js/litematic.js";

const load = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));

test("liest ein echtes Preset-Tile", () => {
  const doc = load("presets/straight/straight.litematic");
  assert.equal(doc.regions.length, 1);
  const r = doc.regions[0];
  assert.equal(r.sizeX, r.sizeZ); // Tiles sind quadratisch
  const corner = r.get(0, 0, 0);
  assert.ok(typeof corner.id === "string" && corner.id.startsWith("minecraft:"));
});

test("liest das grosse maze.litematic und findet Luft + Stein", () => {
  const r = load("maze.litematic").regions[0];
  assert.equal(r.sizeX, 100);
  assert.equal(r.sizeY, 3);
  const ids = new Set();
  for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) ids.add(r.get(x, 1, z).id);
  assert.ok(ids.size >= 2); // mindestens Luft + Wandmaterial
});

test("write -> parse Roundtrip", () => {
  const stone = { id: "minecraft:stone", props: {} };
  const stairs = { id: "minecraft:oak_stairs", props: { facing: "north", half: "bottom" } };
  const palette = [AIR, stone, stairs];
  const [sx, sy, sz] = [3, 2, 3];
  const blocks = new Uint32Array(sx * sy * sz);
  blocks[(0 * sz + 0) * sx + 0] = 1;            // (0,0,0) Stein
  blocks[(1 * sz + 2) * sx + 2] = 2;            // (2,1,2) Treppe
  const bytes = writeLitematic({
    name: "t", author: "test", sizeX: sx, sizeY: sy, sizeZ: sz,
    palette, blocks, timestamp: 1785228778445,
  });
  const doc = parseLitematic(bytes);
  assert.equal(doc.name, "t");
  const r = doc.regions[0];
  assert.deepEqual(r.get(0, 0, 0), stone);
  assert.deepEqual(r.get(2, 1, 2), stairs);
  assert.deepEqual(r.get(1, 0, 1), AIR);
});

test("Palette > 4 Eintraege erzwingt mehr Bits (Spill ueber Long-Grenzen)", () => {
  const palette = [AIR];
  for (let i = 1; i <= 20; i++) palette.push({ id: `minecraft:b${i}`, props: {} });
  const [sx, sy, sz] = [7, 3, 5]; // 105 Eintraege * 5 bits = 525 bits, spannt Longs
  const blocks = new Uint32Array(sx * sy * sz).map((_, i) => i % 21);
  const doc = parseLitematic(writeLitematic({
    name: "p", author: "t", sizeX: sx, sizeY: sy, sizeZ: sz,
    palette, blocks, timestamp: 0,
  }));
  const r = doc.regions[0];
  let i = 0;
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    assert.equal(stateKey(r.get(x, y, z)), stateKey(palette[i % 21]), `Index ${i}`);
    i++;
  }
});
```

- [ ] **Step 2: Fehlschlag verifizieren** — `node --test web/test/litematic.test.js`, Expected: FAIL

- [ ] **Step 3: Implementierung**

`web/js/litematic.js` mit `packBlockStates`/`unpackBlockStates` (Code oben), `parseLitematic` (NBT lesen, je Region Size normalisieren zu positiven Ausdehnungen mit Ursprung an der Min-Ecke: `minX = min(Position.x, Position.x + Size.x + 1)` — litemapy-Konvention; bei ausschließlich selbst geschriebenen Dateien sind Sizes positiv, aber Nutzer-Tiles können aus Litematica mit negativen Sizes kommen), `writeLitematic` (Struktur exakt wie oben; `TotalBlocks` = Anzahl Indizes ≠ 0). Properties-Compound nur schreiben, wenn `props` nicht leer (litemapy lässt `Properties` bei Luft weg — im Roundtrip-Test sichtbar).

- [ ] **Step 4: Tests laufen lassen** — Expected: alle PASS

- [ ] **Step 5: Gegenprobe mit litemapy**

```bash
node -e "
import('./web/js/litematic.js').then(async (L) => {
  const { writeFileSync } = await import('node:fs');
  const { gzipSync } = await import('node:zlib');
  const palette = [L.AIR, { id: 'minecraft:stone', props: {} }];
  const blocks = new Uint32Array(2 * 2 * 2).fill(1);
  blocks[0] = 0;
  const bytes = L.writeLitematic({ name: 'x', author: 'web', sizeX: 2, sizeY: 2, sizeZ: 2, palette, blocks, timestamp: Date.now() });
  writeFileSync('/tmp/webtest.litematic', gzipSync(bytes));
});"
.venv/bin/python -c "
from litemapy import Schematic
s = Schematic.load('/tmp/webtest.litematic')
r = list(s.regions.values())[0]
assert r[0,0,0].id == 'minecraft:air', r[0,0,0]
assert r[1,1,1].id == 'minecraft:stone'
print('litemapy liest Web-Export: OK')"
```

Expected: `litemapy liest Web-Export: OK`

- [ ] **Step 6: Commit**

```bash
git add web/js/litematic.js web/test/litematic.test.js
git commit -m "feat(web): Litematic-Parser/-Writer inkl. Long-Bitpacking"
```

---

### Task 6: Tiles + Varianten (`tiles.js`, `variants.js`)

**Files:**
- Create: `web/js/tiles.js`, `web/js/variants.js`
- Test: `web/test/tiles.test.js`
- Referenz: `maze2schematic/tiles.py` (komplett), `presets/variants.json`

**Interfaces:**
- Consumes: `parseLitematic`, `stateKey`, `AIR` (Task 5); `CANONICAL_MASKS`-Namen (Task 3).
- Produces (`variants.js`):
  - `export function parseVariantsConfig(json)` — nimmt das geparste `variants.json`-Objekt, liefert `{weights: Object<string,number>, clusters: Object<string,{minSize,maxSize}>}`. Semantik wie `_load_config` (tiles.py:167-207), aber: `map`-Feld wird ignoriert mit `console.warn` (Spec: Bias-Maps entfallen); altes flaches Format (nur Gewichte) weiter akzeptieren; ungültige Gewichte/Clustergrößen werfen `TileError`.
- Produces (`tiles.js`):
  - `export class TileError extends Error {}`
  - `export function rotateStateCw(state)` — Port von `rotate_state_cw` (tiles.py:38-60) inkl. der Tabellen `_FACING_CW`, `_AXIS_CW`, `_RAIL_SHAPE_CW`, `_SIDE_PROPS` (tiles.py:20-35). Gibt neues `{id, props}` zurück, Input unverändert.
  - `export function tileFromParsed(doc, name)` — nimmt das Ergebnis von `parseLitematic`, validiert (genau 1 Region sonst `TileError`; quadratische Grundfläche sonst `TileError`), liefert `{name, size, height, blocks}` mit `blocks[x][y][z] = {id, props}` (wie tiles.py:88-113). `doc.warnings` (Tile-Entities) reicht der Aufrufer ans UI durch.
  - `export function rotatedCw(tile)` — Port von `Tile.rotated_cw` (tiles.py:71-81): `(x,z) -> (size-1-z, x)`.
  - `export const ALIASES` — wie `_ALIASES` (tiles.py:117-124); `export const REQUIRED = ["dead_end", "straight", "turn", "tee", "cross"];`
  - `export function styleOf(stem, alias)` — Port von `_style_of` (tiles.py:149-156); `export const DEFAULT_STYLE = "";`
  - `export class TileSet` mit:
    - `static fromEntries(entries, config)` — `entries` = Array `{filename: string, doc: parseLitematic-Ergebnis}`; ordnet über Dateinamen-Stem + `ALIASES`/`styleOf` den kanonischen Typen zu (ersetzt das Dateisystem-Layout von `_find_tile_files` — im Web gibt es nur eine flache Liste von Dateien, egal ob aus dem Manifest oder per Drag&Drop). Validierung wie `TileSet.load` (tiles.py:230-261): Gewicht 0 schließt aus, Default-Style pro Typ Pflicht, `REQUIRED` vollständig, alle Tiles gleiche `(size, height)` — sonst `TileError` mit denselben Fehlertexten (deutsch).
    - `get(name, rotation, style)` — mit Rotations-Cache wie tiles.py:279-292, unbekannter Style fällt auf `DEFAULT_STYLE` zurück.
    - Fehlt das optionale `closed`-Tile, synthetisiert `fromEntries` eines (Spec "Fehlerbehandlung"): Grundfläche/Höhe wie die anderen Tiles, komplett gefüllt mit dem häufigsten Nicht-Luft-Block des `straight`-Tiles. Test dazu: `TileSet.fromEntries` ohne closed-Dateien wirft NICHT, und `get("closed", 0, DEFAULT_STYLE)` liefert ein Tile ohne Luft-Blöcke.
    - `styleWeights()` — wie tiles.py:263-269.
    - `size`, `height`, `variants`, `clusters` Felder analog.

- [ ] **Step 1: Failing Tests schreiben**

```js
// web/test/tiles.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseLitematic, stateKey } from "../js/litematic.js";
import { TileSet, TileError, rotateStateCw, rotatedCw, tileFromParsed, styleOf, DEFAULT_STYLE } from "../js/tiles.js";
import { parseVariantsConfig } from "../js/variants.js";

const loadDoc = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));

function presetEntries() {
  const files = [
    "presets/deadend/deadend.litematic", "presets/deadend/deadend_slim.litematic",
    "presets/straight/straight.litematic", "presets/straight/straight_slim.litematic",
    "presets/turn/turn.litematic", "presets/turn/turn_slim.litematic",
    "presets/tcross/tcross.litematic", "presets/tcross/tcross_slim.litematic",
    "presets/xcross/xcross.litematic", "presets/xcross/xcross_slim.litematic",
    "presets/closed/closed.litematic", "presets/closed/closed_slim.litematic",
  ];
  return files.map((p) => ({ filename: p.split("/").pop(), doc: loadDoc(p) }));
}
const config = () => parseVariantsConfig(JSON.parse(readFileSync("presets/variants.json", "utf8")));

test("rotateStateCw dreht facing/axis/rotation/rails/side-props", () => {
  assert.equal(rotateStateCw({ id: "a", props: { facing: "north" } }).props.facing, "east");
  assert.equal(rotateStateCw({ id: "a", props: { axis: "x" } }).props.axis, "z");
  assert.equal(rotateStateCw({ id: "a", props: { axis: "y" } }).props.axis, "y");
  assert.equal(rotateStateCw({ id: "a", props: { rotation: "14" } }).props.rotation, "2");
  assert.equal(rotateStateCw({ id: "a", props: { shape: "north_east" } }).props.shape, "south_east");
  const fence = rotateStateCw({ id: "f", props: { north: "true", east: "false", south: "true", west: "false" } });
  assert.deepEqual(
    [fence.props.north, fence.props.east, fence.props.south, fence.props.west],
    ["false", "true", "false", "true"],
  );
});

test("4x rotatedCw ist Identitaet (echtes Preset-Tile)", () => {
  const tile = tileFromParsed(loadDoc("presets/turn/turn.litematic"), "turn");
  let t = tile;
  for (let i = 0; i < 4; i++) t = rotatedCw(t);
  for (let x = 0; x < tile.size; x++)
    for (let y = 0; y < tile.height; y++)
      for (let z = 0; z < tile.size; z++)
        assert.equal(stateKey(t.blocks[x][y][z]), stateKey(tile.blocks[x][y][z]));
});

test("styleOf trennt Alias und Style", () => {
  assert.equal(styleOf("straight", "straight"), DEFAULT_STYLE);
  assert.equal(styleOf("straight_slim", "straight"), "slim");
  assert.equal(styleOf("fancy", "straight"), "fancy");
});

test("TileSet aus Presets: Groesse, Styles, Rotation-Cache", () => {
  const ts = TileSet.fromEntries(presetEntries(), config());
  assert.ok(ts.size > 0 && ts.height > 0);
  assert.ok(Object.keys(ts.variants).includes("tee")); // tcross-Alias aufgeloest
  const t0 = ts.get("turn", 1, "slim");
  const t1 = ts.get("turn", 1, "slim");
  assert.equal(t0, t1); // gecacht
  assert.equal(ts.get("turn", 5, DEFAULT_STYLE), ts.get("turn", 1, DEFAULT_STYLE)); // rotation % 4
});

test("TileSet: fehlende Pflicht-Tiles werfen TileError", () => {
  const entries = presetEntries().filter((e) => !e.filename.startsWith("xcross"));
  assert.throws(() => TileSet.fromEntries(entries, config()), TileError);
});

test("parseVariantsConfig: echtes variants.json + Fehlerfaelle", () => {
  const c = config();
  assert.ok(c.clusters.slim.minSize >= 1);
  assert.ok(c.clusters.slim.maxSize >= c.clusters.slim.minSize);
  assert.throws(() => parseVariantsConfig({ weights: { a: -1 } }), TileError);
  assert.throws(() => parseVariantsConfig({ clusters: { s: { min: 5, max: 2 } } }), TileError);
  // altes flaches Format
  assert.deepEqual(parseVariantsConfig({ straight: 3 }).weights, { straight: 3 });
});
```

- [ ] **Step 2: Fehlschlag verifizieren** — `node --test web/test/tiles.test.js`, Expected: FAIL

- [ ] **Step 3: Implementierung**

`web/js/variants.js` (klein, zuerst) und `web/js/tiles.js` nach den Interface-Vorgaben; Rotations-Tabellen wörtlich aus tiles.py:20-35 übernehmen. In `TileSet.fromEntries`: Stems ohne `.litematic`-Endung bilden; pro kanonischem Typ über `ALIASES` die passenden Stems einsammeln (`stem === alias` oder `stem.startsWith(alias + "_")`); Gewicht aus `config.weights[stem] ?? 1`.

- [ ] **Step 4: Tests laufen lassen** — Expected: alle PASS

- [ ] **Step 5: Commit**

```bash
git add web/js/tiles.js web/js/variants.js web/test/tiles.test.js
git commit -m "feat(web): Tile-Loader, Blockstate-Rotation und TileSet mit Varianten"
```

---

### Task 7: Assembly (`assemble.js`)

**Files:**
- Create: `web/js/assemble.js`
- Test: `web/test/assemble.test.js`
- Referenz: `maze2schematic/assemble.py` (ohne Bias-Map-Teile: `load_bias_map` entfällt, `bias`-Parameter entfallen)

**Interfaces:**
- Consumes: `classify` (Task 3), `TileSet`/`DEFAULT_STYLE` (Task 6), `stateKey`/`AIR` (Task 5), `makeRng` (Task 1), Maze-Modell (Task 2).
- Produces:
  - `export function assignStyles(maze, tileset, rng)` → `string[][]` — Port von `assign_styles` + `_grow_cluster` + `_free_for` + `_neighbors` (assemble.py:63-164), Bias-Zweige ersatzlos gestrichen. `rng.randRange` für `randrange`, `rng.randIntRange` für `randint`.
  - `export function assembleBlocks(maze, tileset, rng, styles = null)` → `{sizeX, sizeY, sizeZ, palette, blocks}` — Port von `assemble` (assemble.py:171-196), aber statt litemapy-Region direkt das Format, das `writeLitematic` (Task 5) konsumiert: `palette[0] = AIR`, `blocks` = `Uint32Array`, Index `(y * sizeZ + z) * sizeX + x`. Palette wird beim Setzen aufgebaut (Map `stateKey -> index`).
  - `export function tileStats(maze)` → `Object<string, number>` — wie assemble.py:199-204.

- [ ] **Step 1: Failing Tests schreiben**

```js
// web/test/assemble.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { makeRng } from "../js/rng.js";
import { generateMaze, defaultOptions } from "../js/generate.js";
import { parseLitematic, stateKey, AIR } from "../js/litematic.js";
import { TileSet } from "../js/tiles.js";
import { parseVariantsConfig } from "../js/variants.js";
import { assignStyles, assembleBlocks } from "../js/assemble.js";

const loadDoc = (p) => parseLitematic(new Uint8Array(gunzipSync(readFileSync(p))));
function tileset() {
  const files = ["deadend/deadend", "deadend/deadend_slim", "straight/straight", "straight/straight_slim",
    "turn/turn", "turn/turn_slim", "tcross/tcross", "tcross/tcross_slim",
    "xcross/xcross", "xcross/xcross_slim", "closed/closed", "closed/closed_slim"];
  const entries = files.map((f) => ({ filename: f.split("/")[1] + ".litematic", doc: loadDoc(`presets/${f}.litematic`) }));
  return TileSet.fromEntries(entries, parseVariantsConfig(JSON.parse(readFileSync("presets/variants.json", "utf8"))));
}

test("assignStyles: jede Zelle hat einen Style, slim-Anteil grob nach Gewicht", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(1));
  const grid = assignStyles(maze, ts, makeRng(1));
  assert.equal(grid.length, maze.rows);
  let slim = 0, total = 0;
  for (const row of grid) for (const s of row) { total++; if (s === "slim") slim++; }
  assert.equal(total, maze.rows * maze.cols);
  const weights = ts.styleWeights();
  const expected = weights.slim / (weights.slim + weights[""]);
  assert.ok(Math.abs(slim / total - expected) < 0.2, `slim-Anteil ${slim / total} vs ${expected}`);
});

test("assignStyles: slim-Cluster sind zusammenhaengend und in min/max", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(2));
  const grid = assignStyles(maze, ts, makeRng(2));
  const { minSize, maxSize } = ts.clusters.slim;
  const seen = new Set();
  for (let r = 0; r < maze.rows; r++) for (let c = 0; c < maze.cols; c++) {
    if (grid[r][c] !== "slim" || seen.has(r + "," + c)) continue;
    // Flood-Fill entlang der Gaenge (Cluster wachsen nur ueber offene Kanten)
    const cluster = [];
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const key = cr + "," + cc;
      if (seen.has(key)) continue;
      seen.add(key);
      cluster.push([cr, cc]);
      for (const d of maze.masks[cr][cc]) {
        const nr = cr + (d === 2 ? 1 : 0) - (d === 0 ? 1 : 0);
        const nc = cc + (d === 1 ? 1 : 0) - (d === 3 ? 1 : 0);
        if (nr >= 0 && nr < maze.rows && nc >= 0 && nc < maze.cols && grid[nr][nc] === "slim") stack.push([nr, nc]);
      }
    }
    assert.ok(cluster.length >= minSize && cluster.length <= maxSize,
      `Cluster bei ${r},${c}: ${cluster.length} nicht in [${minSize},${maxSize}]`);
  }
});

test("assembleBlocks: Groesse, Palette, Determinismus", () => {
  const ts = tileset();
  const maze = generateMaze(defaultOptions(), makeRng(3));
  const a = assembleBlocks(maze, ts, makeRng(3));
  assert.equal(a.sizeX, maze.cols * ts.size);
  assert.equal(a.sizeZ, maze.rows * ts.size);
  assert.equal(a.sizeY, ts.height);
  assert.equal(a.blocks.length, a.sizeX * a.sizeY * a.sizeZ);
  assert.equal(stateKey(a.palette[0]), stateKey(AIR));
  assert.ok(a.palette.length >= 2);
  const b = assembleBlocks(maze, ts, makeRng(3));
  assert.deepEqual([...a.blocks], [...b.blocks]);
});
```

- [ ] **Step 2: Fehlschlag verifizieren** — `node --test web/test/assemble.test.js`, Expected: FAIL

- [ ] **Step 3: Implementierung**

Port nach Interface-Vorgaben. Cluster-Wachstum: `_grow_cluster` ohne Bias heißt `frontier.pop(rng.randRange(frontier.length))` → in JS `frontier.splice(rng.randRange(frontier.length), 1)[0]`. In `assembleBlocks` das Tile-Blockgitter zellenweise kopieren (Schleifenstruktur assemble.py:185-193), Palette-Indizes über eine `Map` von `stateKey` auflösen.

- [ ] **Step 4: Tests laufen lassen** — Expected: alle PASS

- [ ] **Step 5: Commit**

```bash
git add web/js/assemble.js web/test/assemble.test.js
git commit -m "feat(web): Style-Cluster und Schematic-Assembly (assemble.js)"
```

---

### Task 8: gzip + Download (`export.js`)

**Files:**
- Create: `web/js/export.js`
- Test: `web/test/export.test.js`

**Interfaces:**
- Consumes: nichts Projektinternes (bewusst — auch von `main.js` und vom Preset-Loader nutzbar).
- Produces:
  - `export async function gzip(uint8)` → `Uint8Array` — via `CompressionStream("gzip")`.
  - `export async function gunzip(uint8)` → `Uint8Array` — via `DecompressionStream("gzip")`; wirft bei kaputten Daten.
  - `export function supportsCompression()` → `typeof CompressionStream !== "undefined"`.
  - `export function downloadBlob(bytes, filename)` — erzeugt `Blob`, `URL.createObjectURL`, klickt ein `a[download]`, revoked die URL. (Browser-only; wird nicht in Node getestet.)

- [ ] **Step 1: Failing Test schreiben**

```js
// web/test/export.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { gzip, gunzip, supportsCompression } from "../js/export.js";

test("gzip-Roundtrip und Kompatibilitaet mit node:zlib", async () => {
  assert.ok(supportsCompression());
  const data = new Uint8Array(10000).map((_, i) => i % 251);
  const zipped = await gzip(data);
  assert.ok(zipped.length < data.length);
  assert.deepEqual([...(await gunzip(zipped))], [...data]);
  assert.deepEqual([...gunzipSync(zipped)], [...data]); // echtes gzip-Format
});
```

- [ ] **Step 2: Fehlschlag verifizieren** — `node --test web/test/export.test.js`, Expected: FAIL

- [ ] **Step 3: Implementierung**

```js
// web/js/export.js
async function pipe(uint8, stream) {
  const out = new Response(
    new Blob([uint8]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

export const supportsCompression = () => typeof CompressionStream !== "undefined";
export const gzip = (u8) => pipe(u8, new CompressionStream("gzip"));
export const gunzip = (u8) => pipe(u8, new DecompressionStream("gzip"));

export function downloadBlob(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Tests laufen lassen** — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/js/export.js web/test/export.test.js
git commit -m "feat(web): gzip via CompressionStream und Blob-Download"
```

---

### Task 9: Preset-Assets + Manifest (`web/presets/`, `scripts/make_web_presets.py`)

**Files:**
- Create: `scripts/make_web_presets.py`
- Create (generiert): `web/presets/**` (Tiles + `variants.json` + `index.json`)

**Interfaces:**
- Produces: `web/presets/index.json` mit Schema `{"files": ["deadend/deadend.litematic", ...], "variants": "variants.json"}` — Pfade relativ zu `web/presets/`. `main.js` (Task 10) lädt erst das Manifest, dann jede Datei per `fetch` als `ArrayBuffer`.

- [ ] **Step 1: Skript schreiben**

```python
# scripts/make_web_presets.py
"""Kopiert presets/ nach web/presets/ und erzeugt index.json (GitHub Pages
hat kein Directory-Listing). Nach Aenderungen an presets/ erneut ausfuehren."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "presets"
DST = ROOT / "web" / "presets"


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    files = []
    for src in sorted(SRC.rglob("*.litematic")):
        rel = src.relative_to(SRC)
        dst = DST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        files.append(str(rel))
    manifest = {"files": files}
    variants = SRC / "variants.json"
    if variants.is_file():
        shutil.copy2(variants, DST / "variants.json")
        manifest["variants"] = "variants.json"
    (DST / "index.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(files)} Tiles nach {DST} kopiert.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Ausführen und verifizieren**

Run: `python3 scripts/make_web_presets.py && cat web/presets/index.json`
Expected: 12 Tiles kopiert; `index.json` listet alle 12 Pfade + `"variants": "variants.json"`. (Hinweis: `slim_map.txt` wird bewusst NICHT kopiert — Bias-Maps entfallen im Web.)

- [ ] **Step 3: Commit**

```bash
git add scripts/make_web_presets.py web/presets
git commit -m "feat(web): Preset-Tiles als statische Assets mit Manifest"
```

---

### Task 10: UI-Grundgerüst (`index.html`, `style.css`, `main.js`)

**Files:**
- Create: `web/index.html`, `web/css/style.css`, `web/js/main.js`
- Referenz für Parameter: Spec Abschnitt "UI"; `DUNGEON_PRESETS` (Task 2)

**Interfaces:**
- Consumes: alle Kern-Module (Tasks 1-8), `web/presets/index.json` (Task 9).
- Produces (für Tasks 11/12):
  - `index.html` enthält: `<canvas id="maze-canvas">`, `<canvas id="topdown-canvas">`, `<div id="view-3d">`, Tab-Buttons `#tab-maze`, `#tab-topdown`, `#tab-3d`, Panel-Inputs (ids unten), `#download-btn`, `#tile-drop` (Drop-Zone), `#tile-status` (Liste der Tile-Typen), `#messages` (Fehler/Warnungen).
  - `main.js` exportiert nichts; es hält den State und ruft nach jeder Änderung `render()`:
    1. `state.maze = generateMaze(optionsFromForm(), makeRng(seed))` — synchron.
    2. `document.dispatchEvent(new CustomEvent("maze-changed", {detail: state}))` — `preview2d.js` hört darauf.
    3. debounced (250 ms): `state.assembly = assembleBlocks(state.maze, state.tileset, makeRng(seed))`, danach `CustomEvent "assembly-changed"` — `preview2d.js` (Top-Down) und `preview3d.js` hören darauf.
  - `state` = `{maze, tileset, assembly, options}` — hängt zusätzlich an `window.appState` (Debugging).

**Input-IDs** (Werte wie CLI-Defaults, generate.py:32-41): `#cols` (number, 20), `#rows` (number, 20), `#seed` (number, zufälliger Startwert), `#straightness`, `#shortcuts`, `#coverage`, `#rooms` (range 0..1 step 0.01), `#h-loop`, `#v-loop`, `#h-mirror`, `#v-mirror`, `#h-border` (checked), `#v-border` (checked), `#entrances` (checked) (checkbox), `#dungeon` (select: "custom" + die 11 Preset-Namen), `#schematic-name` (text, "maze"), `#author` (text, "maze2schematic-web").

**Verhalten:**

- Preset-Wahl in `#dungeon` schreibt die Preset-Werte in die Inputs (via `presetOptions`) und rendert; jede manuelle Slider-Änderung danach stellt `#dungeon` auf "custom".
- Beim Laden: Presets per `fetch("presets/index.json")` + alle Dateien laden, `gunzip` (Task 8), `parseLitematic`, `TileSet.fromEntries`. Fehler (z.B. `file://`-Aufruf) → Meldung in `#messages`: Presets brauchen HTTP(S), Drag&Drop geht trotzdem.
- Drag&Drop auf `#tile-drop`: `.litematic`-Dateien sammeln sich in `state.userFiles` (Map filename → `{filename, doc}`, wie das `entries`-Format aus Task 6). Sobald die `REQUIRED`-Typen abgedeckt sind, wird `TileSet.fromEntries([...state.userFiles.values()], {weights: {}, clusters: {}})` der aktive Satz (ersetzt Presets komplett, wie Spec); vorher zeigt `#tile-status` die fehlenden Typen. `TileError` → Meldung, Datei verworfen, alter Satz bleibt. Reset-Button `#tile-reset` stellt Presets wieder her.
- `#download-btn`: `writeLitematic({...state.assembly, name, author, timestamp: Date.now()})` → `gzip` → `downloadBlob(bytes, name + ".litematic")`. Ohne `supportsCompression()`: Button disabled + Meldung.
- `#messages`: einfache Liste, neueste oben, mit Schließen-Knopf; Warnungen aus `doc.warnings` (Tile-Entities) landen hier.

**Layout (`style.css`):** Flexbox, Panel links (feste Breite ~300px, scrollbar), Vorschau rechts (füllt Rest); Tabs schalten `display` der drei Vorschau-Container; dunkles Farbschema (jsmaze-artig schlicht). Responsive: unter 800px Breite stapeln (Panel oben).

- [ ] **Step 1: HTML + CSS + main.js schreiben** (kein automatisierter Test — Browser-Integrationsschicht; die Logik dahinter ist durch Tasks 1-8 getestet. `preview2d`/`preview3d` existieren noch nicht: `main.js` importiert sie erst ab Task 11/12 — bis dahin nur Events dispatchen.)

- [ ] **Step 2: Manuell verifizieren**

Run: `python3 -m http.server 8080 -d web` und `open http://localhost:8080`
Expected: Seite lädt ohne Konsolenfehler, Tile-Status zeigt 6 Typen mit je 2 Varianten, Download-Button liefert eine `.litematic` (noch ohne sichtbare Vorschau). Heruntergeladene Datei prüfen:

```bash
.venv/bin/python -c "
from litemapy import Schematic
s = Schematic.load('$HOME/Downloads/maze.litematic')
r = list(s.regions.values())[0]
print('OK', abs(r.width), abs(r.height), abs(r.length))"
```

Expected: `OK 100 <tile-hoehe> 100`

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/css/style.css web/js/main.js
git commit -m "feat(web): UI-Panel, Preset-/Tile-Laden und Litematic-Download"
```

---

### Task 11: 2D-Vorschau (`preview2d.js`)

**Files:**
- Create: `web/js/preview2d.js`
- Modify: `web/index.html` (Script-Import ergänzen)

**Interfaces:**
- Consumes: Events `maze-changed` / `assembly-changed` (Task 10), Maze-Modell, `stateKey` (Task 5).
- Produces: rendert in `#maze-canvas` und `#topdown-canvas`; `export function drawMaze(canvas, maze)` und `export function drawTopdown(canvas, assembly)` (exportiert, damit sie einzeln aufrufbar bleiben).

**`drawMaze`:** Wand-Linien zeichnen: Zellgröße `s = Math.floor(Math.min(canvas.width / maze.cols, canvas.height / maze.rows))`, für jede Zelle für jede NICHT offene Richtung die entsprechende Kante als Linie (N: obere Kante usw.). Geschlossene Zellen (`mask.size === 0`) zusätzlich gefüllt (Wandfarbe). Canvas vorher auf Elterngröße syncen (`canvas.width = canvas.clientWidth` — einmal pro Draw, DPR beachten: `ctx.scale(devicePixelRatio, ...)`).

**`drawTopdown`:** pro Säule `(x, z)` von oben (`y = sizeY-1` abwärts) den ersten Nicht-Luft-Block suchen, dessen Farbe als `fillRect(x*px, z*px, px, px)`. Farbzuordnung: `colorForBlock(id)` — kleine Tabelle für gängige Blöcke (stone/cobblestone-Grau, oak/spruce-Braun, leaves/grass-Grün, water-Blau, air → dunkler Hintergrund), sonst deterministische Hash-Farbe: Hash über die id → HSL mit fester S/L. Tabelle als exportiertes `BLOCK_COLORS`-Objekt, damit `preview3d.js` (Task 12) dieselben Farben nutzt.

- [ ] **Step 1: Implementieren + in `main.js` einhängen** (Import + Event-Listener registrieren)

- [ ] **Step 2: Manuell verifizieren**

Run: `python3 -m http.server 8080 -d web`, im Browser: Maze-Tab zeigt beim Slider-Ziehen sofort neue Labyrinthe; Top-Down-Tab zeigt nach ~250 ms die Blockfarben; Preset "catacombs" zeigt große massive Bereiche.

- [ ] **Step 3: Commit**

```bash
git add web/js/preview2d.js web/index.html web/js/main.js
git commit -m "feat(web): 2D-Maze- und Top-Down-Vorschau"
```

---

### Task 12: 3D-Vorschau (`preview3d.js` + three.js vendoren)

**Files:**
- Create: `web/vendor/three.module.js`, `web/vendor/OrbitControls.js`, `web/js/preview3d.js`
- Modify: `web/index.html`, `web/js/main.js` (Import + Listener)

**Interfaces:**
- Consumes: Event `assembly-changed`, `BLOCK_COLORS`/`colorForBlock` (Task 11), Assembly-Modell (Task 7).
- Produces: rendert in `#view-3d`; `export function updateScene(assembly)`.

- [ ] **Step 1: three.js vendoren**

```bash
mkdir -p web/vendor
curl -fsSL -o web/vendor/three.module.js https://unpkg.com/three@0.160.0/build/three.module.js
curl -fsSL -o web/vendor/OrbitControls.js https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js
```

Danach in `OrbitControls.js` den Import `from 'three'` auf `from './three.module.js'` ändern (der examples-Build importiert das bare specifier `three`; ohne Import-Map muss der Pfad relativ sein). Lizenzhinweis: three.js ist MIT — `web/vendor/LICENSE-three.txt` mit MIT-Header von three.js anlegen.

- [ ] **Step 2: `preview3d.js` implementieren**

Szene: `PerspectiveCamera`, `OrbitControls` (Target = Schematic-Mitte), `AmbientLight` + `DirectionalLight`. Geometrie: **ein** `BufferGeometry`-Mesh, Face-Culling per Hand — für jeden Nicht-Luft-Block nur die Flächen emittieren, deren Nachbar Luft/außerhalb ist; pro Fläche 4 Vertices + 2 Dreiecke in `position`/`normal`/`color`-Attribute (Farbe aus `colorForBlock`, Material `MeshLambertMaterial({vertexColors: true})`). Bei jedem `assembly-changed`: altes Mesh disposen (`geometry.dispose()`), neu bauen. Render-Loop nur bei sichtbarem 3D-Tab (`requestAnimationFrame` pausieren, wenn Tab inaktiv). Guard: `sizeX * sizeZ > 1_000_000` (~ >200x200 Zellen bei 5er-Tiles) → statt Mesh eine Meldung "3D-Ansicht für diese Größe deaktiviert" in `#view-3d`.

- [ ] **Step 3: Manuell verifizieren**

Run: `python3 -m http.server 8080 -d web`; 3D-Tab: Maze als drehbares Voxel-Modell, Wände/Böden in Blockfarben, Kamera-Orbit mit Maus, keine sichtbaren Innenflächen-Artefakte, flüssig bei 50x50 Zellen (Frame-Zeit < 30 ms nach dem Aufbau).

- [ ] **Step 4: Commit**

```bash
git add web/vendor web/js/preview3d.js web/index.html web/js/main.js
git commit -m "feat(web): 3D-Voxel-Vorschau mit three.js (vendort)"
```

---

### Task 13: Deployment-Politur + Python-Gegenprobe

**Files:**
- Create: `index.html` (Repo-Root, Redirect), `web/test/crosscheck.py`
- Modify: `README.md` (Abschnitt "Web-Version")

**Interfaces:**
- Consumes: kompletten Stack.

- [ ] **Step 1: Root-Redirect anlegen**

```html
<!-- index.html (Repo-Root) -->
<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=web/">
<a href="web/">maze2schematic-web</a>
```

- [ ] **Step 2: Gegenprobe-Skript schreiben**

```python
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
```

- [ ] **Step 3: End-to-End-Gegenprobe**

Im Browser (lokaler Server) ein 20x20-Maze mit Seed 42 exportieren, dann:

Run: `.venv/bin/python web/test/crosscheck.py ~/Downloads/maze.litematic`
Expected: `OK: 100x...` — und die Datei zusätzlich einmal in Litematica (Minecraft) laden, sofern eine Instanz greifbar ist; sonst genügt die litemapy-Probe.

- [ ] **Step 4: README ergänzen**

Abschnitt "Web-Version" in `README.md` (nach dem Intro): Link auf die GitHub-Pages-URL (Platzhalter `https://<user>.github.io/<repo>/`), Kurzbeschreibung (Generator + Tiles + Export im Browser), Hinweis auf `scripts/make_web_presets.py` nach Preset-Änderungen, lokaler Start mit `python3 -m http.server 8080 -d web` (vom Repo-Root: Root-`index.html` + `web/`), Hinweis dass Tests mit `node --test web/test/` laufen.

- [ ] **Step 5: Gesamttestlauf + Commit**

Run: `node --test web/test/`
Expected: alle Tests PASS.

```bash
git add index.html web/test/crosscheck.py README.md
git commit -m "feat(web): Root-Redirect, litemapy-Gegenprobe und README"
```

- [ ] **Step 6: GitHub Pages aktivieren (manuell, mit dem User)**

Repo auf GitHub pushen, dann Settings → Pages → "Deploy from a branch" → `main`, Ordner `/ (root)`. URL testen. (Braucht ein Remote — falls noch keins existiert, mit dem User klären, unter welchem Namen/Account das Repo laufen soll.)
