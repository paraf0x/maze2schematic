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
import { TileSet, TileError, ALIASES, styleOf } from "./tiles.js";
import { parseVariantsConfig } from "./variants.js";
import { assembleBlocks } from "./assemble.js";
import { parseLitematic, writeLitematic } from "./litematic.js";
import { gzip, gunzip, supportsCompression, downloadBlob } from "./export.js";
import { drawMaze, drawTopdown, drawTileThumb } from "./preview2d.js";
import { updateScene, setActive as set3dActive, handleResize as handle3dResize } from "./preview3d.js";

const ASSEMBLY_DEBOUNCE_MS = 250;
const WEIGHT_DEBOUNCE_MS = 300;
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 10;
const THUMB_SIZE = 48;

function clampInt(value, lo, hi, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, n));
}

/** Resolves a stem (filename without ".litematic") to its canonical tile
 * type via the same alias rule as tiles.js's `findTileFiles`/`styleOf`:
 * the stem either equals an alias exactly (base variant) or starts with
 * "<alias>_" (style variant). Returns `null` if no alias matches -- e.g. a
 * dropped file with an unrelated name. */
function typeForStem(stem) {
  for (const canonical of TILE_NAMES) {
    for (const alias of ALIASES[canonical] ?? []) {
      if (stem === alias || stem.startsWith(alias + "_")) return canonical;
    }
  }
  return null;
}

/** Alias (within its canonical type's ALIASES list) that a stem resolves
 * through -- needed to compute the style label (styleOf(stem, alias)). */
function aliasForStem(stem, canonical) {
  return ALIASES[canonical].find((alias) => stem === alias || stem.startsWith(alias + "_"));
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
    tileFileInput: document.getElementById("tile-file-input"),
    tileManager: document.getElementById("tile-manager"),
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
    // Unified tile pool: stem (filename without ".litematic") -> {filename,
    // doc, source}. Presets and user-added files live in the same pool;
    // adding a file with an existing stem overrides it. `source` is
    // "preset" or "user", used only to render the "user" badge.
    pool: new Map(),
    disabled: new Set(), // stems
    weights: {}, // stem -> number (unlisted stems default to 1 at rebuild)
    clusters: {}, // parsed clusters config from the presets, kept as-is
    // Snapshot of the presets alone (pool/weights/clusters), used by the
    // "Restore presets" button. Set once loadPresets() succeeds.
    presets: null,
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
  // Tile manager: unified pool (presets + user files), per-tile enable/
  // disable and weight, grouped by canonical type with a preview thumbnail.
  // ---------------------------------------------------------------------

  /** Rebuilds state.tileset from the current pool/disabled/weights/
   * clusters. Effective weight per stem: 0 if disabled, else the stored
   * weight (default 1 for stems with no explicit weight). On success,
   * updates state.tileset and returns true. On TileError (e.g. disabling a
   * base variant, or every variant, of a required type), shows the error
   * via addMessage and returns false -- the caller is responsible for
   * reverting whatever pool/disabled/weights change caused it. */
  function rebuildTileset() {
    const effectiveWeights = {};
    for (const stem of state.pool.keys()) {
      effectiveWeights[stem] = state.disabled.has(stem) ? 0 : (state.weights[stem] ?? 1);
    }
    try {
      state.tileset = TileSet.fromEntries([...state.pool.values()], {
        weights: effectiveWeights,
        clusters: state.clusters,
      });
      return true;
    } catch (err) {
      if (err instanceof TileError) {
        addMessage(err.message, "error");
      } else {
        addMessage(`Unexpected error building tile set: ${err.message}`, "error");
      }
      return false;
    }
  }

  /** Applies a pool/disabled/weights mutation, then rebuilds the tile set.
   * On success, re-renders the tile manager and triggers a maze/assembly
   * re-render. On failure, reverts to the pre-mutation snapshot (so the UI
   * never stays in a broken state) and only re-renders the tile manager.
   * Returns whether the mutation was kept. */
  function applyPoolChange(mutate) {
    const snapshot = {
      pool: new Map(state.pool),
      disabled: new Set(state.disabled),
      weights: { ...state.weights },
    };
    mutate();
    const ok = rebuildTileset();
    if (ok) {
      renderTileManager();
      render();
    } else {
      state.pool = snapshot.pool;
      state.disabled = snapshot.disabled;
      state.weights = snapshot.weights;
      renderTileManager();
    }
    return ok;
  }

  function renderTileManager() {
    els.tileManager.innerHTML = "";
    if (state.pool.size === 0) {
      const p = document.createElement("p");
      p.className = "tile-manager-empty";
      p.textContent = "No tiles loaded.";
      els.tileManager.appendChild(p);
      return;
    }

    const byType = new Map(TILE_NAMES.map((name) => [name, []]));
    for (const stem of state.pool.keys()) {
      const type = typeForStem(stem);
      if (type) byType.get(type).push(stem);
    }

    for (const type of TILE_NAMES) {
      const stems = byType.get(type);
      if (stems.length === 0) continue;
      stems.sort();

      const group = document.createElement("div");
      group.className = "tile-group";
      const h3 = document.createElement("h3");
      h3.textContent = type;
      group.appendChild(h3);
      for (const stem of stems) {
        group.appendChild(renderTileRow(stem, type));
      }
      els.tileManager.appendChild(group);
    }
  }

  function renderTileRow(stem, type) {
    const entry = state.pool.get(stem);
    const alias = aliasForStem(stem, type);
    const style = styleOf(stem, alias);
    const isDisabled = state.disabled.has(stem);

    const row = document.createElement("div");
    row.className = "tile-row" + (isDisabled ? " tile-row-disabled" : "");

    const canvas = document.createElement("canvas");
    canvas.className = "tile-thumb";
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const region = entry.doc.regions[0];
    if (region) {
      try {
        drawTileThumb(canvas, region);
      } catch {
        // Malformed/irregular region -- leave the thumbnail blank rather
        // than breaking the whole tile manager.
      }
    }
    row.appendChild(canvas);

    const label = document.createElement("span");
    label.className = "tile-name";
    label.textContent = style ? `${stem} (${style})` : stem;
    row.appendChild(label);

    if (entry.source === "user") {
      const badge = document.createElement("span");
      badge.className = "tile-badge";
      badge.textContent = "user";
      row.appendChild(badge);
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tile-enabled";
    checkbox.checked = !isDisabled;
    checkbox.title = "Enabled";
    checkbox.addEventListener("change", () => {
      applyPoolChange(() => {
        if (checkbox.checked) state.disabled.delete(stem);
        else state.disabled.add(stem);
      });
    });
    row.appendChild(checkbox);

    const weightInput = document.createElement("input");
    weightInput.type = "number";
    weightInput.className = "tile-weight";
    weightInput.min = String(WEIGHT_MIN);
    weightInput.max = String(WEIGHT_MAX);
    weightInput.step = "0.5";
    weightInput.title = "Weight";
    weightInput.value = String(state.weights[stem] ?? 1);
    weightInput.addEventListener("input", () => {
      scheduleWeightChange(stem, weightInput.value);
    });
    row.appendChild(weightInput);

    return row;
  }

  const weightTimers = new Map(); // stem -> timeout id
  function scheduleWeightChange(stem, rawValue) {
    if (weightTimers.has(stem)) clearTimeout(weightTimers.get(stem));
    weightTimers.set(
      stem,
      setTimeout(() => {
        weightTimers.delete(stem);
        applyPoolChange(() => {
          state.weights[stem] = clampWeight(rawValue);
        });
      }, WEIGHT_DEBOUNCE_MS),
    );
  }

  // ---------------------------------------------------------------------
  // Adding tiles: drag & drop and the file-picker button both funnel
  // through this one function.
  // ---------------------------------------------------------------------

  async function addTileFiles(fileList) {
    const allFiles = [...fileList];
    const files = allFiles.filter((f) => /\.litematic$/i.test(f.name));
    if (files.length === 0) {
      if (allFiles.length > 0) {
        addMessage("Only .litematic files are supported.", "warning");
      }
      return;
    }

    const parsed = [];
    for (const file of files) {
      let doc;
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        doc = parseLitematic(await gunzip(raw));
      } catch (err) {
        addMessage(`${file.name}: ${err.message}`, "error");
        continue;
      }
      for (const warning of doc.warnings) {
        addMessage(`${file.name}: ${warning}`, "warning");
      }
      const stem = file.name.replace(/\.litematic$/i, "");
      if (!typeForStem(stem)) {
        addMessage(
          `${file.name} does not match any tile type (expected: straight, turn, ` +
            "tee/tcross, cross/xcross, dead_end/deadend, closed -- optionally with a " +
            "_<style> suffix).",
          "warning",
        );
        continue;
      }
      parsed.push({ stem, filename: file.name, doc });
    }

    if (parsed.length === 0) return;

    const ok = applyPoolChange(() => {
      for (const { stem, filename, doc } of parsed) {
        state.pool.set(stem, { filename, doc, source: "user" });
      }
    });
    if (ok) {
      addMessage(`${parsed.length} tile${parsed.length === 1 ? "" : "s"} added.`, "info");
    }
  }

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
    await addTileFiles(ev.dataTransfer?.files ?? []);
  });

  els.tileFileInput.addEventListener("change", async () => {
    await addTileFiles(els.tileFileInput.files);
    els.tileFileInput.value = ""; // allow re-adding the same file(s) later
  });

  els.tileReset.addEventListener("click", () => {
    if (!state.presets) {
      addMessage("No presets available.", "warning");
      return;
    }
    state.pool = new Map(state.presets.pool);
    state.disabled.clear();
    state.weights = { ...state.presets.weights };
    state.clusters = state.presets.clusters;
    if (rebuildTileset()) {
      addMessage("Presets restored.", "info");
    }
    renderTileManager();
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
          "Adding your own tiles (drag & drop or the Add tiles button) still works.",
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

      const pool = new Map();
      for (const { filename, doc } of entries) {
        const stem = filename.replace(/\.litematic$/i, "");
        pool.set(stem, { filename, doc, source: "preset" });
      }

      state.pool = pool;
      state.weights = { ...config.weights };
      state.clusters = config.clusters;
      state.presets = { pool: new Map(pool), weights: { ...config.weights }, clusters: config.clusters };

      rebuildTileset();
      renderTileManager();
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

  renderTileManager();
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
