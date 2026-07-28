# Design: maze2schematic-web

Datum: 2026-07-28
Status: Entwurf genehmigt (Brainstorming-Session)

## Ziel

Statische Webseite im Stil von [jsmaze](https://morgan3d.github.io/misc/jsmaze/),
die auf GitHub Pages läuft: Labyrinth-Parameter einstellen, Vorschau live in 2D
und 3D sehen, per Knopfdruck ein `.litematic`-Schematic herunterladen. Voller
Funktionsumfang des bestehenden Python-Tools (Generator, Dungeon-Presets,
Tile-Assembly mit Varianten und Clustern) plus Upload eigener Tiles. Alles
läuft client-seitig; kein Server, kein Build-Schritt.

## Entscheidungen (aus dem Brainstorming)

- **Umfang:** Voller Port des Python-Tools + Upload eigener `.litematic`-Tiles
  per Drag&Drop. Bias-Maps werden weggelassen.
- **Maze-Quelle:** Nur der eingebaute Generator. Kein SVG-Upload.
- **Vorschau:** 2D-Maze live (jsmaze-Stil) + Top-Down-Blockansicht + drehbare
  3D-Voxel-Ansicht (three.js).
- **Export:** Nur `.litematic`.
- **Stack:** Vanilla JS mit ES-Modulen, kein Build-Schritt. three.js als
  vendorte Datei. gzip nativ über `CompressionStream`.

## Struktur

Neuer Ordner `web/` im bestehenden Projekt:

```text
web/
  index.html
  css/style.css
  js/
    main.js          # UI-Verdrahtung, State, Re-Render-Trigger
    generate.js      # Port von generate.py (jsmaze-Algorithmus + Dungeon-Presets)
    classify.js      # Port von classify.py (Zellmaske -> Tile-Typ + Rotation)
    nbt.js           # NBT lesen + schreiben
    litematic.js     # .litematic-Parser/-Writer auf Basis von nbt.js (ersetzt litemapy)
    tiles.js         # Port von tiles.py (Tile-Loader, 90-Grad-Rotation inkl. Blockstates)
    variants.js      # Varianten-Gewichte + Cluster (variants.json-Logik aus assemble.py)
    assemble.js      # Gesamt-Schematic zusammensetzen
    preview2d.js     # Canvas: Maze-Linien + Top-Down-Blockansicht
    preview3d.js     # three.js: Voxel-Ansicht
    export.js        # gzip via CompressionStream, Blob-Download
    rng.js           # seedbarer PRNG
  vendor/three.module.js
  presets/           # Kopie der preset-Tiles + variants.json + index.json (Manifest)
```

Die Kern-Module (`generate`, `classify`, `nbt`, `litematic`, `tiles`,
`variants`, `assemble`, `rng`) sind UI-frei und in Node lauffähig — das
ermöglicht Tests ohne Browser.

## Datenfluss

1. Parameter-Änderung im UI → `generate()` erzeugt das Zellgitter (Zellen mit
   offenen Richtungen N/O/S/W, wie `generate.py`).
2. 2D-Maze-Preview zeichnet das Zellgitter sofort (Canvas, Liniendarstellung).
3. Debounced danach: `classify()` + Tile-Wahl (Varianten/Cluster) +
   `assemble()` erzeugen das Blockgitter. Daraus speisen sich
   Top-Down-Blockansicht und 3D-Ansicht.
4. Download-Button: Blockgitter → NBT → gzip (`CompressionStream`) → Blob →
   Download `maze.litematic`.
5. Ein Seed-Feld macht Generierung und Variantenwahl reproduzierbar. Der PRNG
   ist ein eigener seedbarer Generator (z.B. mulberry32), analog zu
   `random.Random(seed)` im Python-Tool. Gleicher Seed im Web und in Python
   muss NICHT dasselbe Maze ergeben (unterschiedliche PRNGs sind ok);
   Reproduzierbarkeit gilt jeweils innerhalb einer Plattform.

## UI

Ein-Seiten-Layout wie jsmaze: links Parameter-Panel, rechts Vorschau mit
Tab-/Umschalter zwischen 2D-Maze, Top-Down-Blockansicht und 3D-Ansicht.

Parameter (entsprechen den CLI-Optionen):

- Breite x Höhe (Zellen), Seed
- straightness, shortcuts, coverage, rooms (Slider 0..1)
- h-loop, v-loop, h-mirror, v-mirror, h-border, v-border, entrances (Checkboxen)
- Dungeon-Preset-Dropdown (labyrinth, catacombs, hedge, palace, fortress,
  suburb, city, pacman, starship, garden, forbidden) — setzt die Slider,
  einzelne Werte bleiben danach überschreibbar
- Schematic-Name und Autor (Metadaten)
- Tile-Set-Bereich: Liste der geladenen Tile-Typen mit Variantenzahl,
  Drag&Drop-Zone für eigene `.litematic`-Dateien, Reset auf Presets

## Komponenten

### generate.js

1:1-Port von `generate.py` (der selbst ein Port von jsmaze ist). Gleiche
Parameter, gleiche Rundungslogik, gleiche Dungeon-Presets. Ausgabe: Gitter aus
Zellen mit `open`-Flags je Richtung plus `closed`-Status.

### nbt.js + litematic.js

- `nbt.js`: Binär-NBT lesen/schreiben (Big-Endian, alle Tag-Typen, über
  `DataView`). Kein externes Paket.
- `litematic.js`: Versteht das Litematica-Format (Regions,
  BlockStatePalette, gepacktes Long-Array der BlockStates, Metadata).
  Liest Tiles ein und schreibt das Export-Schematic. Ersetzt `litemapy`.
  Tile-Entities werden beim Einlesen ignoriert (Warnung im UI, wie im
  Python-Tool). Version/DataVersion im Export: identisch zu dem, was
  `litemapy` heute schreibt, damit Litematica-Kompatibilität gesichert ist.

### tiles.js + variants.js + assemble.js

Ports von `tiles.py` und `assemble.py`:

- Tile-Validierung: genau eine Region, quadratische Grundfläche, alle Tiles
  gleiche Größe und Höhe.
- 90-Grad-Rotation inkl. Blockstate-Anpassung (`facing`, `axis`, `rotation`,
  Rail-`shape`, Verbindungs-Properties von Zäunen/Scheiben/Mauern) — gleiche
  Property-Tabellen wie in `tiles.py`.
- Varianten: Gewichte aus `variants.json`, Cluster-Wachstum entlang der Gänge
  (min/max-Zellen je Style). Bias-Maps entfallen; das `map`-Feld in
  `variants.json` wird ignoriert (mit Konsolen-Hinweis).

### Preset-Laden + eigene Tiles

- `presets/index.json` (Manifest) listet alle Tile-Dateien, da GitHub Pages
  kein Directory-Listing bietet. Ein kleines Python- oder Shell-Skript
  regeneriert das Manifest (`web/presets/` wird aus `presets/` kopiert).
- Drag&Drop: Nutzer zieht `.litematic`-Dateien auf die Tile-Zone. Zuordnung
  zum Tile-Typ über den Dateinamen (gleiche Konventionen/Aliase wie im
  Python-Tool: `straight`, `turn`, `tee`/`tcross`, `cross`/`xcross`,
  `dead_end`/`deadend`, `closed`; Suffixe wie `_slim` bilden Styles).
  Hochgeladene Tiles ersetzen den kompletten Preset-Satz, sobald mindestens
  die Pflicht-Typen (dead_end, straight, turn, tee, cross) vorhanden sind;
  vorher zeigt das UI an, welche Typen noch fehlen. Ein Reset-Button stellt
  die Presets wieder her. Kein Persistieren über Reloads (YAGNI).

### preview2d.js

- Maze-Ansicht: Linien-Rendering des Zellgitters auf Canvas, Stil an jsmaze
  angelehnt. Aktualisiert synchron bei jeder Parameteränderung.
- Top-Down-Blockansicht: pro Säule (x,z) die Farbe des obersten nicht-Luft
  Blocks; Farbtabelle je Block-ID (angelehnt an Minecraft-Kartenfarben,
  unbekannte IDs bekommen eine Hash-Farbe).

### preview3d.js

- three.js (vendort, keine CDN-Abhängigkeit — GitHub Pages soll offline vom
  eigenen Origin leben können).
- Voxel-Rendering mit Face-Culling: nur Flächen zwischen Block und Luft werden
  als Geometrie erzeugt (ein merged BufferGeometry-Mesh, Vertex-Farben je
  Block-ID). Kein Instancing pro Block — bei 50x50 Zellen à 5x5x5 Tiles sind
  das sonst Millionen Instanzen.
- Farbige Voxel statt Minecraft-Texturen (Texturen sind nicht frei
  redistributierbar).
- OrbitControls (aus three.js-Examples, mit vendort) zum Drehen/Zoomen.
- Aktualisierung debounced nach Assembly; bei sehr großen Mazes (>200x200
  Zellen) wird die 3D-Ansicht mit Hinweis deaktiviert statt den Tab
  einzufrieren.

### export.js

- NBT-Bytes → `CompressionStream('gzip')` → Blob → `a[download]`-Klick.
- Dateiname aus dem Schematic-Namen (`<name>.litematic`).

## Fehlerbehandlung

- Ungültige hochgeladene Tiles (falsche Größe, mehrere Regionen, kein
  gültiges NBT): Fehlermeldung im Tile-Bereich, Datei wird verworfen, der
  bisherige Tile-Satz bleibt aktiv.
- Fehlendes optionales `closed`-Tile: Fallback wie im Python-Tool
  (massiver Block-Füller in Tile-Größe).
- `CompressionStream` nicht verfügbar (sehr alte Browser): Download-Button
  deaktiviert mit Hinweis.
- Preset-Fetch schlägt fehl (z.B. offline geöffnete Datei via `file://`):
  Hinweis, dass Presets nur über HTTP(S) laden — eigene Tiles per Drag&Drop
  funktionieren trotzdem.

## Testing

- Kern-Module sind Node-lauffähig; ein Testskript (`web/test/run.js`, mit
  `node --test` oder schlichtem Assert) deckt ab:
  - `generate`: feste Seeds → Snapshot der Zellgitter; Invarianten
    (Perfektheit bei shortcuts=0: Zellenzahl-1 Verbindungen, alle erreichbar).
  - `classify`: alle 16 Masken → erwarteter Typ + Rotation (direkt aus
    `classify.py` ableitbar).
  - `nbt`/`litematic`: Roundtrip echter Preset-Tiles (lesen → schreiben →
    lesen, identische Paletten/Blöcke).
  - `tiles`-Rotation: Blockstate-Properties nach 4x90 Grad wieder identisch.
- Cross-Check gegen Python: das Export-Schematic aus dem Web-Code wird mit
  `litemapy` in Python eingelesen und stichprobenartig verglichen (Größe,
  Palette, Blöcke an Referenzpositionen). Einmalig manuell beim Entwickeln,
  als Skript im Repo abgelegt.
- Manuelle Prüfung: ein exportiertes Schematic in Litematica laden.

## Deployment

- Git-Repo initialisieren (Projekt ist noch keins), `.gitignore` für `.venv`,
  `__pycache__`, `.DS_Store`.
- GitHub Pages: Pages-Quelle = Branch-Root ("Deploy from branch"). Pages
  liefert dann das Repo-Root aus, die Seite liegt unter
  `https://<user>.github.io/<repo>/web/`. Eine Root-`index.html` mit Redirect
  auf `web/` macht die kurze URL nutzbar. Optional später eine GitHub-Action,
  die nur `web/` deployt — nicht Teil dieses Designs.

## Nicht-Ziele (YAGNI)

- Bias-Maps im Web-UI
- SVG-Import
- `.schem`/WorldEdit-Export
- Echte Minecraft-Texturen
- Persistenz hochgeladener Tiles (localStorage/IndexedDB)
- Mobile-Optimierung über simples responsives Layout hinaus
