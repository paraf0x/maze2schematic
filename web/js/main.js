// UI wiring, state, re-render triggers. Port-independent: holds no porting
// logic itself, just calls the core modules (tasks 1-8) and the preset
// assets (task 9).
//
// Task 12 (`preview3d.js`): the WebGL renderer is created lazily the first
// time the 3D tab is activated (`setActive`), so no WebGL context exists
// before that. `updateScene` is called on every "assembly-changed" (even
// while the 3D tab is inactive) -- as long as the scene isn't initialized
// yet, preview3d.js remembers the assembly and picks it up on the next
// activation.
//
// main.js exports nothing. All DOM wiring lives in `init()`, which only
// runs on DOMContentLoaded (or immediately if the document is already
// ready) -- this keeps the module importable in Node (no `document` needed
// at module load time).

import { makeRng } from "./rng.js";
import { defaultOptions, presetOptions, generateMaze } from "./generate.js";
import { TILE_NAMES } from "./classify.js";
import { TileSet, TileError, REQUIRED, ALIASES } from "./tiles.js";
import { parseVariantsConfig } from "./variants.js";
import { assembleBlocks } from "./assemble.js";
import { parseLitematic, writeLitematic } from "./litematic.js";
import { gzip, gunzip, supportsCompression, downloadBlob } from "./export.js";
import { drawMaze, drawTopdown } from "./preview2d.js";
import { updateScene, setActive as set3dActive, handleResize as handle3dResize } from "./preview3d.js";

const ASSEMBLY_DEBOUNCE_MS = 250;

function clampInt(value, lo, hi, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Stems (filename without ".litematic") per required type that would
 * supply its base variant -- an independent, lightweight mirror of the
 * alias logic in tiles.js, just to show the user which types are still
 * missing BEFORE a (potentially expensive) TileSet.fromEntries attempt. */
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
  // Messages
  // ---------------------------------------------------------------------

  function addMessage(text, level = "error") {
    const li = document.createElement("li");
    li.className = `msg msg-${level}`;
    const span = document.createElement("span");
    span.textContent = text;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "msg-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => li.remove());
    li.append(span, closeBtn);
    els.messages.prepend(li); // newest on top
  }

  // ---------------------------------------------------------------------
  // Form <-> GenerateOptions
  // ---------------------------------------------------------------------

  function optionsFromForm() {
    const cols = clampInt(els.cols.value, 2, 200, 20);
    const rows = clampInt(els.rows.value, 2, 200, 20);
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
    const cols = clampInt(els.cols.value, 2, 200, 20);
    const rows = clampInt(els.rows.value, 2, 200, 20);
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
  // Render pipeline: synchronous maze generation, debounced assembly
  // ---------------------------------------------------------------------

  let assemblyTimer = null;

  // Deliberate deviation from the Python __main__.py: there, maze
  // generation and assembly share a single Random instance; here each
  // phase gets its own fresh makeRng(seed). Reason: the assembly runs
  // debounced (scheduleAssembly) and must be rebuilt deterministically
  // from the current seed on every trigger, without previous calls (e.g.
  // the synchronous maze generation in render()) having "consumed" the
  // RNG state. Reproducibility per platform is preserved since each phase
  // deterministically starts from the same seed.
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
        addMessage(`Assembly failed: ${err.message}`, "error");
        return;
      }
      document.dispatchEvent(new CustomEvent("assembly-changed", { detail: state }));
    }, ASSEMBLY_DEBOUNCE_MS);
  }

  function render() {
    state.options = optionsFromForm();
    try {
      // Own makeRng(seed) instead of a shared Random instance -- see the
      // comment on scheduleAssembly() above.
      state.maze = generateMaze(state.options, makeRng(seedValue()));
    } catch (err) {
      addMessage(`Maze generation failed: ${err.message}`, "error");
      return;
    }
    document.dispatchEvent(new CustomEvent("maze-changed", { detail: state }));
    scheduleAssembly();
  }

  // ---------------------------------------------------------------------
  // 2D previews (task 11): maze view redraws directly on every maze,
  // top-down is debounced together with the assembly. Also redrawn on tab
  // switch, since a previously hidden (`display: none`) canvas still had
  // size 0 at the last event.
  // ---------------------------------------------------------------------

  document.addEventListener("maze-changed", (ev) => {
    drawMaze(els.mazeCanvas, ev.detail.maze);
  });
  document.addEventListener("assembly-changed", (ev) => {
    drawTopdown(els.topdownCanvas, ev.detail.assembly);
    updateScene(ev.detail.assembly);
  });

  // ---------------------------------------------------------------------
  // Wire up parameter inputs
  // ---------------------------------------------------------------------

  // These 10 inputs correspond exactly to the fields of a DUNGEON_PRESETS
  // entry; a manual change sets #dungeon to "custom" (spec).
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

  let currentTab = "maze";

  function selectTab(which) {
    currentTab = which;
    for (const key of Object.keys(tabPanels)) {
      tabPanels[key].style.display = key === which ? "" : "none";
      tabButtons[key].classList.toggle("active", key === which);
    }
    // Redraw: a canvas that was previously "display: none" had
    // clientWidth/Height 0 at the last "maze-changed"/"assembly-changed" event.
    if (which === "maze" && state.maze) {
      drawMaze(els.mazeCanvas, state.maze);
    } else if (which === "topdown" && state.assembly) {
      drawTopdown(els.topdownCanvas, state.assembly);
    }
    // Only run the 3D render loop while the tab is visible (task 12):
    // pauses requestAnimationFrame when switching away from 3D, initializes
    // the renderer lazily on first activation.
    set3dActive(els.view3d, which === "3d");
    if (which === "3d") {
      handle3dResize();
    }
  }
  els.tabMaze.addEventListener("click", () => selectTab("maze"));
  els.tabTopdown.addEventListener("click", () => selectTab("topdown"));
  els.tab3d.addEventListener("click", () => selectTab("3d"));
  selectTab("maze");

  window.addEventListener("resize", () => {
    handle3dResize();
    // Also redraw the currently visible 2D canvas -- its size depends on
    // the container and changes with the window.
    if (currentTab === "maze" && state.maze) {
      drawMaze(els.mazeCanvas, state.maze);
    } else if (currentTab === "topdown" && state.assembly) {
      drawTopdown(els.topdownCanvas, state.assembly);
    }
  });

  // ---------------------------------------------------------------------
  // Tile set status
  // ---------------------------------------------------------------------

  function renderTileStatus() {
    els.tileStatus.innerHTML = "";
    if (state.tileset) {
      for (const name of TILE_NAMES) {
        const variants = state.tileset.variants[name];
        if (!variants) continue;
        const li = document.createElement("li");
        const count = Object.keys(variants).length;
        li.textContent = `${name}: ${count} variant${count === 1 ? "" : "s"}`;
        els.tileStatus.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "No tile set loaded.";
      els.tileStatus.appendChild(li);
    }

    if (state.userFiles.size > 0) {
      const missing = missingRequiredTypes([...state.userFiles.values()]);
      if (missing.length > 0) {
        const li = document.createElement("li");
        li.className = "tile-missing";
        li.textContent = `Missing: ${missing.join(", ")}`;
        els.tileStatus.appendChild(li);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Drag & drop custom tiles
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
    const droppedFiles = [...(ev.dataTransfer?.files ?? [])];
    const files = droppedFiles.filter((f) => /\.litematic$/i.test(f.name));
    if (files.length === 0) {
      if (droppedFiles.length > 0) {
        addMessage("Only .litematic files are supported.", "warning");
      }
      return;
    }

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
        addMessage("Custom tiles active (replacing the presets).", "info");
        renderTileStatus();
        render();
      } catch (err) {
        if (err instanceof TileError) {
          addMessage(err.message, "error");
          for (const key of addedKeys) state.userFiles.delete(key);
          renderTileStatus();
        } else {
          addMessage(`Unexpected error loading tiles: ${err.message}`, "error");
        }
      }
    }
  });

  els.tileReset.addEventListener("click", () => {
    state.userFiles.clear();
    if (state.presetTileset) {
      state.tileset = state.presetTileset;
      addMessage("Presets restored.", "info");
    } else {
      state.tileset = null;
      addMessage("No presets available.", "warning");
    }
    renderTileStatus();
    render();
  });

  // ---------------------------------------------------------------------
  // Load presets (task 9: web/presets/index.json)
  // ---------------------------------------------------------------------

  async function loadPresets() {
    let manifest;
    try {
      const res = await fetch("presets/index.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch {
      addMessage(
        "Presets could not be loaded (requires an HTTP(S) server, e.g. " +
          "`python3 -m http.server` -- opening via file:// doesn't work). " +
          "Drag & drop of custom tiles still works.",
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
      addMessage(`Presets could not be loaded: ${err.message}`, "error");
    }
  }

  // ---------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------

  if (!supportsCompression()) {
    els.downloadBtn.disabled = true;
    addMessage(
      "Your browser doesn't support compression (CompressionStream) -- download not possible.",
      "warning",
    );
  } else {
    els.downloadBtn.addEventListener("click", async () => {
      if (!state.assembly) {
        addMessage("No schematic available yet.", "warning");
        return;
      }
      try {
        const name = (els.schematicName.value || "maze").trim() || "maze";
        const author = (els.author.value || "maze2schematic-web").trim() || "maze2schematic-web";
        const bytes = writeLitematic({ ...state.assembly, name, author, timestamp: Date.now() });
        const gzipped = await gzip(bytes);
        downloadBlob(gzipped, `${name}.litematic`);
      } catch (err) {
        addMessage(`Download failed: ${err.message}`, "error");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Let's go
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
