// UI-Verdrahtung, State, Re-Render-Trigger. Port-unabhaengig: haelt keine
// Portierungs-Logik selbst, sondern ruft nur die Kern-Module (Tasks 1-8) und
// die Preset-Assets (Task 9) auf.
//
// `preview3d.js` existiert erst ab Task 12: bis dahin dispatcht dieses Modul
// das Event "assembly-changed" zwar weiterhin auf `document` (fuer Task 12),
// zeichnet aber selbst nur die 2D-Vorschauen (Task 11, `preview2d.js`).
//
// main.js exportiert nichts. Alle DOM-Verdrahtung steckt in `init()`, das erst
// bei DOMContentLoaded (bzw. sofort, falls das Dokument schon bereit ist)
// laeuft -- so bleibt das Modul in Node importierbar (kein `document` zur
// Modul-Ladezeit noetig).

import { makeRng } from "./rng.js";
import { defaultOptions, presetOptions, generateMaze } from "./generate.js";
import { TILE_NAMES } from "./classify.js";
import { TileSet, TileError, REQUIRED, ALIASES } from "./tiles.js";
import { parseVariantsConfig } from "./variants.js";
import { assembleBlocks } from "./assemble.js";
import { parseLitematic, writeLitematic } from "./litematic.js";
import { gzip, gunzip, supportsCompression, downloadBlob } from "./export.js";
import { drawMaze, drawTopdown } from "./preview2d.js";

const ASSEMBLY_DEBOUNCE_MS = 250;

function clampInt(value, lo, hi, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Stems (Dateiname ohne ".litematic") pro Pflicht-Typ, die dessen
 * Basis-Variante liefern wuerden -- unabhaengige, leichtgewichtige Spiegelung
 * der Alias-Logik aus tiles.js, nur um dem Nutzer VOR einem (evtl. teuren)
 * TileSet.fromEntries-Versuch anzuzeigen, welche Typen noch fehlen. */
function missingRequiredTypes(entries) {
  const stems = new Set(entries.map(({ filename }) => filename.replace(/\.litematic$/i, "")));
  return REQUIRED.filter((canonical) => !ALIASES[canonical].some((alias) => stems.has(alias)));
}

function init() {
  const els = {
    cols: document.getElementById("cols"),
    rows: document.getElementById("rows"),
    seed: document.getElementById("seed"),
    dungeon: document.getElementById("dungeon"),
    straightness: document.getElementById("straightness"),
    shortcuts: document.getElementById("shortcuts"),
    coverage: document.getElementById("coverage"),
    rooms: document.getElementById("rooms"),
    hLoop: document.getElementById("h-loop"),
    vLoop: document.getElementById("v-loop"),
    hMirror: document.getElementById("h-mirror"),
    vMirror: document.getElementById("v-mirror"),
    hBorder: document.getElementById("h-border"),
    vBorder: document.getElementById("v-border"),
    entrances: document.getElementById("entrances"),
    schematicName: document.getElementById("schematic-name"),
    author: document.getElementById("author"),
    tileDrop: document.getElementById("tile-drop"),
    tileStatus: document.getElementById("tile-status"),
    tileReset: document.getElementById("tile-reset"),
    downloadBtn: document.getElementById("download-btn"),
    messages: document.getElementById("messages"),
    tabMaze: document.getElementById("tab-maze"),
    tabTopdown: document.getElementById("tab-topdown"),
    tab3d: document.getElementById("tab-3d"),
    mazeCanvas: document.getElementById("maze-canvas"),
    topdownCanvas: document.getElementById("topdown-canvas"),
    view3d: document.getElementById("view-3d"),
  };

  const state = {
    maze: null,
    tileset: null,
    presetTileset: null,
    userFiles: new Map(), // filename -> {filename, doc}
    assembly: null,
    options: defaultOptions(),
  };
  window.appState = state;

  // ---------------------------------------------------------------------
  // Meldungen
  // ---------------------------------------------------------------------

  function addMessage(text, level = "error") {
    const li = document.createElement("li");
    li.className = `msg msg-${level}`;
    const span = document.createElement("span");
    span.textContent = text;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "msg-close";
    closeBtn.setAttribute("aria-label", "Schließen");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => li.remove());
    li.append(span, closeBtn);
    els.messages.prepend(li); // neueste oben
  }

  // ---------------------------------------------------------------------
  // Formular <-> GenerateOptions
  // ---------------------------------------------------------------------

  function optionsFromForm() {
    const cols = clampInt(els.cols.value, 2, 500, 20);
    const rows = clampInt(els.rows.value, 2, 500, 20);
    return {
      cols,
      rows,
      straightness: Number(els.straightness.value),
      shortcuts: Number(els.shortcuts.value),
      coverage: Number(els.coverage.value),
      rooms: Number(els.rooms.value),
      horizontal: {
        loop: els.hLoop.checked,
        mirror: els.hMirror.checked,
        border: els.hBorder.checked ? 1 : 0,
      },
      vertical: {
        loop: els.vLoop.checked,
        mirror: els.vMirror.checked,
        border: els.vBorder.checked ? 1 : 0,
      },
      entrances: els.entrances.checked,
    };
  }

  function applyPresetToForm(name) {
    const cols = clampInt(els.cols.value, 2, 500, 20);
    const rows = clampInt(els.rows.value, 2, 500, 20);
    const opts = presetOptions(name, cols, rows);
    els.straightness.value = String(opts.straightness);
    els.shortcuts.value = String(opts.shortcuts);
    els.coverage.value = String(opts.coverage);
    els.rooms.value = String(opts.rooms);
    els.hLoop.checked = opts.horizontal.loop;
    els.hMirror.checked = opts.horizontal.mirror;
    els.hBorder.checked = !!opts.horizontal.border;
    els.vLoop.checked = opts.vertical.loop;
    els.vMirror.checked = opts.vertical.mirror;
    els.vBorder.checked = !!opts.vertical.border;
    els.entrances.checked = opts.entrances;
  }

  function seedValue() {
    const n = Math.trunc(Number(els.seed.value));
    return Number.isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------------
  // Render-Pipeline: synchrone Maze-Generierung, debounced Assembly
  // ---------------------------------------------------------------------

  let assemblyTimer = null;

  function scheduleAssembly() {
    if (assemblyTimer) {
      clearTimeout(assemblyTimer);
    }
    assemblyTimer = setTimeout(() => {
      assemblyTimer = null;
      if (!state.tileset || !state.maze) return;
      try {
        state.assembly = assembleBlocks(state.maze, state.tileset, makeRng(seedValue()));
      } catch (err) {
        addMessage(`Zusammenbau fehlgeschlagen: ${err.message}`, "error");
        return;
      }
      document.dispatchEvent(new CustomEvent("assembly-changed", { detail: state }));
    }, ASSEMBLY_DEBOUNCE_MS);
  }

  function render() {
    state.options = optionsFromForm();
    try {
      state.maze = generateMaze(state.options, makeRng(seedValue()));
    } catch (err) {
      addMessage(`Labyrinth-Generierung fehlgeschlagen: ${err.message}`, "error");
      return;
    }
    document.dispatchEvent(new CustomEvent("maze-changed", { detail: state }));
    scheduleAssembly();
  }

  // ---------------------------------------------------------------------
  // 2D-Vorschauen (Task 11): Maze-Ansicht direkt bei jedem Maze, Top-Down
  // gedebounct zusammen mit dem Assembly. Zusaetzlich beim Tab-Wechsel neu
  // gezeichnet, da eine zuvor versteckte (`display: none`) Canvas beim
  // vorherigen Event noch die Groesse 0 hatte.
  // ---------------------------------------------------------------------

  document.addEventListener("maze-changed", (ev) => {
    drawMaze(els.mazeCanvas, ev.detail.maze);
  });
  document.addEventListener("assembly-changed", (ev) => {
    drawTopdown(els.topdownCanvas, ev.detail.assembly);
  });

  // ---------------------------------------------------------------------
  // Parameter-Eingaben verdrahten
  // ---------------------------------------------------------------------

  // Diese 10 Inputs entsprechen genau den Feldern eines DUNGEON_PRESETS-Eintrags;
  // eine manuelle Aenderung stellt #dungeon auf "custom" (Spec).
  const presetControlled = [
    els.straightness, els.shortcuts, els.coverage, els.rooms,
    els.hLoop, els.vLoop, els.hMirror, els.vMirror, els.hBorder, els.vBorder,
  ];
  for (const el of presetControlled) {
    el.addEventListener("input", () => {
      els.dungeon.value = "custom";
      render();
    });
  }
  for (const el of [els.cols, els.rows, els.seed, els.entrances]) {
    el.addEventListener("input", () => render());
  }

  els.dungeon.addEventListener("change", () => {
    if (els.dungeon.value !== "custom") {
      applyPresetToForm(els.dungeon.value);
    }
    render();
  });

  if (!els.seed.value) {
    els.seed.value = String(Math.floor(Math.random() * 2 ** 31));
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  const tabButtons = { maze: els.tabMaze, topdown: els.tabTopdown, "3d": els.tab3d };
  const tabPanels = { maze: els.mazeCanvas, topdown: els.topdownCanvas, "3d": els.view3d };

  function selectTab(which) {
    for (const key of Object.keys(tabPanels)) {
      tabPanels[key].style.display = key === which ? "" : "none";
      tabButtons[key].classList.toggle("active", key === which);
    }
    // Neu zeichnen: eine Canvas, die vorher "display: none" war, hatte beim
    // letzten "maze-changed"/"assembly-changed"-Event clientWidth/Height 0.
    if (which === "maze" && state.maze) {
      drawMaze(els.mazeCanvas, state.maze);
    } else if (which === "topdown" && state.assembly) {
      drawTopdown(els.topdownCanvas, state.assembly);
    }
  }
  els.tabMaze.addEventListener("click", () => selectTab("maze"));
  els.tabTopdown.addEventListener("click", () => selectTab("topdown"));
  els.tab3d.addEventListener("click", () => selectTab("3d"));
  selectTab("maze");

  // ---------------------------------------------------------------------
  // Tile-Set-Status
  // ---------------------------------------------------------------------

  function renderTileStatus() {
    els.tileStatus.innerHTML = "";
    if (state.tileset) {
      for (const name of TILE_NAMES) {
        const variants = state.tileset.variants[name];
        if (!variants) continue;
        const li = document.createElement("li");
        const count = Object.keys(variants).length;
        li.textContent = `${name}: ${count} Variante${count === 1 ? "" : "n"}`;
        els.tileStatus.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "Kein Tile-Set geladen.";
      els.tileStatus.appendChild(li);
    }

    if (state.userFiles.size > 0) {
      const missing = missingRequiredTypes([...state.userFiles.values()]);
      if (missing.length > 0) {
        const li = document.createElement("li");
        li.className = "tile-missing";
        li.textContent = `Fehlend: ${missing.join(", ")}`;
        els.tileStatus.appendChild(li);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Drag & Drop eigener Tiles
  // ---------------------------------------------------------------------

  els.tileDrop.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    els.tileDrop.classList.add("dragover");
  });
  els.tileDrop.addEventListener("dragleave", () => {
    els.tileDrop.classList.remove("dragover");
  });
  els.tileDrop.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    els.tileDrop.classList.remove("dragover");
    const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => /\.litematic$/i.test(f.name));
    if (files.length === 0) return;

    const addedKeys = [];
    for (const file of files) {
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        const doc = parseLitematic(await gunzip(raw));
        for (const warning of doc.warnings) {
          addMessage(`${file.name}: ${warning}`, "warning");
        }
        state.userFiles.set(file.name, { filename: file.name, doc });
        addedKeys.push(file.name);
      } catch (err) {
        addMessage(`${file.name}: ${err.message}`, "error");
      }
    }

    renderTileStatus();

    if (missingRequiredTypes([...state.userFiles.values()]).length === 0) {
      try {
        const tileset = TileSet.fromEntries([...state.userFiles.values()], { weights: {}, clusters: {} });
        state.tileset = tileset;
        addMessage("Eigene Tiles aktiv (ersetzen die Presets).", "info");
        renderTileStatus();
        render();
      } catch (err) {
        if (err instanceof TileError) {
          addMessage(err.message, "error");
          for (const key of addedKeys) state.userFiles.delete(key);
          renderTileStatus();
        } else {
          throw err;
        }
      }
    }
  });

  els.tileReset.addEventListener("click", () => {
    state.userFiles.clear();
    if (state.presetTileset) {
      state.tileset = state.presetTileset;
      addMessage("Presets wiederhergestellt.", "info");
    } else {
      state.tileset = null;
      addMessage("Keine Presets verfügbar.", "warning");
    }
    renderTileStatus();
    render();
  });

  // ---------------------------------------------------------------------
  // Presets laden (Task 9: web/presets/index.json)
  // ---------------------------------------------------------------------

  async function loadPresets() {
    let manifest;
    try {
      const res = await fetch("presets/index.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch {
      addMessage(
        "Presets konnten nicht geladen werden (benötigt einen HTTP(S)-Server, z.B. " +
          "`python3 -m http.server` -- Aufruf per file:// funktioniert nicht). " +
          "Drag & Drop eigener Tiles funktioniert trotzdem.",
        "warning",
      );
      return;
    }

    try {
      const entries = await Promise.all(
        manifest.files.map(async (relPath) => {
          const res = await fetch(`presets/${relPath}`);
          if (!res.ok) throw new Error(`${relPath}: HTTP ${res.status}`);
          const raw = new Uint8Array(await res.arrayBuffer());
          const doc = parseLitematic(await gunzip(raw));
          for (const warning of doc.warnings) {
            addMessage(`${relPath}: ${warning}`, "warning");
          }
          return { filename: relPath.split("/").pop(), doc };
        }),
      );

      let config = { weights: {}, clusters: {} };
      if (manifest.variants) {
        const vres = await fetch(`presets/${manifest.variants}`);
        if (vres.ok) {
          config = parseVariantsConfig(await vres.json());
        }
      }

      const tileset = TileSet.fromEntries(entries, config);
      state.presetTileset = tileset;
      if (!state.tileset) {
        state.tileset = tileset;
      }
      renderTileStatus();
      render();
    } catch (err) {
      addMessage(`Presets konnten nicht geladen werden: ${err.message}`, "error");
    }
  }

  // ---------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------

  if (!supportsCompression()) {
    els.downloadBtn.disabled = true;
    addMessage(
      "Dein Browser unterstützt keine Kompression (CompressionStream) -- Download nicht möglich.",
      "warning",
    );
  } else {
    els.downloadBtn.addEventListener("click", async () => {
      if (!state.assembly) {
        addMessage("Noch kein Schematic verfügbar.", "warning");
        return;
      }
      try {
        const name = (els.schematicName.value || "maze").trim() || "maze";
        const author = (els.author.value || "maze2schematic-web").trim() || "maze2schematic-web";
        const bytes = writeLitematic({ ...state.assembly, name, author, timestamp: Date.now() });
        const gzipped = await gzip(bytes);
        downloadBlob(gzipped, `${name}.litematic`);
      } catch (err) {
        addMessage(`Download fehlgeschlagen: ${err.message}`, "error");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Los geht's
  // ---------------------------------------------------------------------

  renderTileStatus();
  render();
  loadPresets();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
