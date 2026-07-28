# maze2schematic

Baut aus einem Labyrinth und Litematica-Tile-Schematics ein Gesamt-Schematic
fuer Minecraft. Als Labyrinth-Quelle dient entweder eine SVG
(mazegenerator.net, "Line Maze"-Format) oder der eingebaute Generator
(Portierung von [jsmaze](https://morgan3d.github.io/misc/jsmaze/) von
Morgan McGuire, BSD-Lizenz).

## Web-Version

Unter `https://<user>.github.io/<repo>/` laeuft eine statische Portierung
komplett im Browser: Generator, Tile-Zusammenbau und Export laufen als
JavaScript client-seitig, es wird kein Server benoetigt (ausser zum
Ausliefern der statischen Dateien). Presets, 2D-/3D-Vorschau und der
Litematica-Export (`.litematic`, gzip-komprimiert) sind ohne Python oder
Installation nutzbar.

Die Web-Presets unter `web/presets/` sind eine Kopie von `presets/`; nach
Aenderungen an `presets/` (neue Tiles, `variants.json`) muss

```bash
.venv/bin/python scripts/make_web_presets.py
```

erneut ausgefuehrt werden, um `web/presets/` und dessen `index.json` zu
aktualisieren.

Lokal starten (vom Repo-Root, damit sowohl die Root-`index.html` als auch
`web/` erreichbar sind):

```bash
python3 -m http.server 8080
```

und dann <http://localhost:8080/web/> im Browser oeffnen. Alternativ direkt
mit `web/` als Docroot:

```bash
python3 -m http.server 8080 -d web
```

Tests laufen mit Node (kein Build-Schritt noetig):

```bash
node --test web/test/*.test.js
```

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Nutzung

```bash
# 1. (Optional) Beispiel-Tiles erzeugen, falls noch keine eigenen vorhanden sind
.venv/bin/python -m maze2schematic.make_default_tiles tiles

# 2. Vorschau: erkanntes Labyrinth als ASCII pruefen
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --preview

# 3. Schematic bauen
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --tiles tiles -o maze.litematic

# Alternativ: Labyrinth generieren statt SVG (jsmaze-Algorithmus)
.venv/bin/python -m maze2schematic --generate 20x20 --tiles presets -o maze.litematic
.venv/bin/python -m maze2schematic --generate 30x20 --dungeon catacombs --seed 7 --tiles presets -o dungeon.litematic
```

Weitere Optionen: `--name`, `--author` fuer die Schematic-Metadaten und
`--seed` fuer reproduzierbare Generierung und Variantenauswahl (siehe unten).

## Generator (jsmaze)

Mit `--generate SPALTENxZEILEN` wird das Labyrinth direkt erzeugt
(Algorithmus von [jsmaze](https://morgan3d.github.io/misc/jsmaze/)).
Parameter:

- `--straightness 0..1`: bevorzugt gerade Gaenge
- `--shortcuts 0..1`: zusaetzliche Verbindungen, erzeugt Loops (0 = perfektes
  Labyrinth mit eindeutiger Loesung)
- `--coverage 0..1`: wie viel der Flaeche ausgegraben wird; bei < 1 bleiben
  massive Bereiche stehen (closed-Tiles)
- `--rooms 0..1`: Anteil der Sackgassen, die zu Raeumen ausgebaut werden
- `--h-loop` / `--v-loop`: umlaufend (Torus); Gaenge enden offen am Rand,
  sinnvoll wenn das Schematic gekachelt wird
- `--h-mirror` / `--v-mirror`: Spiegelsymmetrie (Loesbarkeit nicht garantiert)
- `--no-h-border` / `--no-v-border`: ohne Aussenwand
- `--no-entrances`: keinen Ein-/Ausgang oben/unten in den Rand stanzen
- `--dungeon NAME`: Parameter-Presets der jsmaze-Website
  (labyrinth, catacombs, hedge, palace, fortress, suburb, city, pacman,
  starship, garden, forbidden); einzelne Optionen ueberschreiben das Preset

Hinweise: Die tatsaechliche Groesse kann je nach Optionen leicht abweichen
(der Algorithmus rundet). Raeume koennen im Original Wandpfosten entfernen;
im Tile-Modell bleiben die Pfosten der cross-Tiles als Saeulen stehen --
Raeume werden also zu Saeulenhallen. Vollstaendig geschlossene Zellen nutzen
das closed-Tile (komplett massiv).

## SVG-Format

Erwartet wird das "Line Maze"-Format von [mazegenerator.net](https://www.mazegenerator.net/):
Die Polylines sind die **begehbaren Pfade** (nicht die Waende) und verbinden die
Zentren benachbarter Zellen. Ein-/Ausgang sind kurze Stummel ueber den Rand
hinaus. Zellgroesse und Gitterausdehnung werden automatisch erkannt, die
Labyrinth-Groesse ist also beliebig.

## Tile-Konventionen

Der Tiles-Ordner unterstuetzt zwei Layouts:

- flach: `tiles/straight.litematic`, `tiles/tee.litematic`, ...
- Unterordner (presets): `presets/straight/*.litematic`, `presets/tcross/*.litematic`, ...
  Jede `.litematic`-Datei im Unterordner ist eine **Variante** des Tile-Typs,
  aus der pro Zelle zufaellig gewaehlt wird. Als Ordnernamen sind auch die
  Aliase `tcross` (= tee), `xcross` (= cross) und `deadend` (= dead_end) erlaubt.

Jedes Tile hat genau eine Region, eine quadratische Grundflaeche (z.B. 5x5) und
alle Tiles muessen dieselbe Groesse und Hoehe haben. Die Tile-Groesse wird aus
den Dateien gelesen, 5x5 ist also nicht fest verdrahtet.

### Varianten-Konfiguration (`variants.json`)

Eine optionale `variants.json` im Tiles-Ordner steuert Gewichte und
Cluster-Verhalten der Varianten:

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

- `weights`: Schluessel ist der Dateiname ohne `.litematic`. Nicht
  aufgefuehrte Varianten haben Gewicht 1, Gewicht 0 deaktiviert eine
  Variante. Die Gewichte bestimmen den Flaechenanteil je Variante.
- `clusters`: Varianten werden ueber ihren Namens-Suffix zu einem "Style"
  gruppiert (`straight_slim` + `turn_slim` + ... = Style `slim`). Ein
  Cluster-Eintrag sorgt dafuer, dass dieser Style in zusammenhaengenden
  Bereichen von `min` bis `max` Zellen entlang der Gaenge auftritt statt
  einzeln verstreut. Ohne Eintrag werden Zellen einzeln gewuerfelt.
- `map` (optional): Bias-Map, die steuert, **wo** die Cluster eines Styles
  entstehen. Pfad relativ zum Tiles-Ordner; ohne `map` ist die Verteilung
  gleichmaessig zufaellig.

Mit `--seed <zahl>` ist die Verteilung reproduzierbar.

### Bias-Map

Eine Bias-Map ist ein Textraster in Labyrinth-Groesse: eine Zeile pro
Labyrinth-Zeile, ein Zeichen pro Zelle. Ziffer `0`-`9` = Gewicht der Zelle,
`.` = 1, `0` sperrt die Zelle komplett. Zeilen, die mit `#` beginnen, sind
Kommentare. Seeds und Wachstum der Cluster bevorzugen Zellen mit hohem
Gewicht; der Gesamtanteil des Styles bleibt durch `weights` bestimmt.

Eine leere Vorlage in der passenden Groesse erzeugt:

```bash
.venv/bin/python -m maze2schematic "20 by 20 orthogonal maze.svg" --map-template presets/slim_map.txt
```

Beispiel (obere Haelfte gesperrt, unten erlaubt, rechts unten bevorzugt):

```
00000000000000000000
00000000000000000000
...
11112222333344445555
33344445555666677778
```

Pro Typ wird nur **eine** Datei in kanonischer Ausrichtung benoetigt; alle
Rotationen erzeugt das Tool selbst (inklusive Blockstates wie `facing`, `axis`,
`rotation`, Rail-`shape` und Verbindungs-Properties von Zaeunen/Scheiben/Mauern).

| Datei | offene Seiten (kanonisch) | benoetigt |
| --- | --- | --- |
| `dead_end.litematic` | Norden | ja |
| `straight.litematic` | Nord + Sued | ja |
| `turn.litematic` | Nord + Ost | ja |
| `tee.litematic` | Ost + Sued + West (zu: Norden) | ja |
| `cross.litematic` | alle vier | ja |
| `closed.litematic` | keine | optional |

"Norden" im Tile = die -Z-Richtung in Litematica; im fertigen Schematic zeigt
die oberste SVG-Zeile nach -Z. Damit die Wege zusammenpassen, sollten die
Oeffnungen an den Kanten bei allen Tiles an denselben Positionen liegen (bei
den Beispiel-Tiles: der mittlere 3er-Streifen jeder Kante).

Hinweise:

- Tile-Entities (Kisten, Schilder, ...) in Tiles werden derzeit ignoriert
  (Warnung beim Laden).
- Waende zwischen zwei Tiles sind doppelt so dick wie eine Tile-Randwand, da
  jedes Tile seinen eigenen Rand mitbringt.

## Projektstruktur

- `maze2schematic/svg_parser.py` - SVG zu Zellgitter mit offenen Richtungen
- `maze2schematic/generate.py` - jsmaze-Portierung (Generator statt SVG)
- `maze2schematic/classify.py` - Zellmaske zu Tile-Typ + Rotation
- `maze2schematic/tiles.py` - Tile-Loader und 90-Grad-Rotator
- `maze2schematic/assemble.py` - setzt das Gesamt-Schematic zusammen
- `maze2schematic/make_default_tiles.py` - erzeugt einfache Beispiel-Tiles
- `maze2schematic/make_presets.py` - erzeugt die presets/-Struktur (breite + slim-Varianten, variants.json)
- `maze2schematic/__main__.py` - CLI
