// UI wiring, state, re-render triggers. Port-independent: holds no porting
// logic itself, just calls the core modules (tasks 1-8) and the theme
// assets (task 9, extended: themes).
//
// Themes: a THEME is a named tile set (tiles + weights + disabled flags +
// clusters). Built-in themes ship as static assets under web/themes/ (see
// scripts/make_web_themes.py); user themes are saved in localStorage
// (serialized via ./themes.js). Switching the active theme rebuilds the
// tile set/assembly only -- it never touches state.maze, so restyling a
// maze via the theme dropdown is instant and keeps the current layout.
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
import { TILE_NAMES, arrowSpecs } from "./classify.js";
import { TileSet, TileError, ALIASES, styleOf, rotateDoc } from "./tiles.js";
import { parseVariantsConfig } from "./variants.js";
import { assembleBlocks } from "./assemble.js";
import { parseLitematic, writeLitematic } from "./litematic.js";
import { gzip, gunzip, supportsCompression, downloadBlob } from "./export.js";
import { serializeTheme, deserializeTheme } from "./themes.js";
import { drawMaze, drawTopdown, drawTileThumb } from "./preview2d.js";
import {
  updateScene,
  setActive as set3dActive,
  handleResize as handle3dResize,
  assemblyFromRegion,
  renderTileImage,
} from "./preview3d.js";

const ASSEMBLY_DEBOUNCE_MS = 250;
const WEIGHT_DEBOUNCE_MS = 300;
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 10;
const THUMB_SIZE = 48;
const THUMB_RENDER_SIZE = 96; // backing resolution for the 3D thumbnail, 2x THUMB_SIZE for sharpness

const LS_ACTIVE_THEME_KEY = "maze2schematic.activeTheme";
const LS_USER_THEMES_KEY = "maze2schematic.userThemes";
const FALLBACK_THEME_ID = "classic";

// Short orientation hint per canonical tile type, shown in the tile import
// modal under the type <select> once a type is chosen.
const TYPE_ORIENTATION_HINTS = {
  dead_end: "opens north",
  straight: "opens north + south",
  turn: "opens north + east",
  tee: "opens east + south + west",
  cross: "opens all sides",
  closed: "no openings",
};

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

/** Sanitizes a user-entered variant name to the pool's stem alphabet:
 * lowercase `[a-z0-9_-]+`. Used both for the tile import modal's variant
 * input and for its prefilled guess (the filename's `_<style>` suffix, if
 * any). Disallowed characters are dropped, not substituted. */
function sanitizeVariant(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
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
    themeSelect: document.getElementById("theme-select"),
    themeSave: document.getElementById("theme-save"),
    themeDelete: document.getElementById("theme-delete"),
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
    // doc, bytes, source}. `bytes` are the tile's uncompressed NBT bytes
    // (needed to serialize the pool into a user theme, see ./themes.js).
    // Built-in and user-added files live in the same pool; adding a file
    // with an existing stem overrides it. `source` is "preset" or "user",
    // used only to render the "user" badge.
    pool: new Map(),
    disabled: new Set(), // stems
    weights: {}, // stem -> number (unlisted stems default to 1 at rebuild)
    clusters: {}, // parsed clusters config from the active theme, kept as-is
    assembly: null,
    options: defaultOptions(),

    // ---- Themes -----------------------------------------------------
    themes: [], // built-in theme metas from themes/index.json: {id, label, dir, files, variants?}
    userThemes: new Map(), // id -> deserialized theme {id, label, tiles:[{filename,bytes}], weights, disabled, clusters}
    builtinThemeCache: new Map(), // built-in theme id -> loaded {pool, weights, disabled, clusters} (avoids refetching on every switch)
    activeTheme: null, // id of the currently active theme (built-in or user), or null if none could be loaded
    // Whether the tile manager has been edited since the active theme was
    // selected/saved/reset -- shown as " •" appended to its <option> label.
    themeModified: false,
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
      state.themeModified = true;
      renderTileManager();
      populateThemeSelect();
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

    const legend = document.createElement("p");
    legend.className = "tile-manager-hint";
    legend.textContent =
      "Arrows show each type's expected openings (green in, orange out). " +
      "Disable the closed tile to leave solid cells empty in the schematic.";
    els.tileManager.appendChild(legend);

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

  /** Builds the tile row's preview element: a small static isometric 3D
   * render (via preview3d.js) when WebGL is available and rendering
   * succeeds, falling back to the existing 2D top-down canvas thumbnail
   * (`drawTileThumb`) otherwise -- e.g. no WebGL, or a malformed/irregular
   * region that throws. Both element kinds share the `.tile-thumb` class
   * (sizing/border/background), so nothing else needs to know which one it
   * got.
   *
   * Both renderers get `arrowSpecs(type)` -- the CANONICAL expected
   * openings for the row's tile type, not derived from the tile's actual
   * blocks, so rotating the tile (which doesn't change its type) never
   * changes the arrows. A `title` tooltip spells out the color legend. */
  function renderTileThumbEl(region, type) {
    const arrows = arrowSpecs(type);
    const title =
      arrows.length > 0
        ? `green = entrance (in), orange = exits (out) — expected openings for ${type}`
        : `${type}: no openings expected`;

    let dataUrl = null;
    if (region) {
      try {
        const assembly = assemblyFromRegion(region);
        dataUrl = renderTileImage(assembly, THUMB_RENDER_SIZE, arrows);
      } catch {
        dataUrl = null;
      }
    }
    if (dataUrl) {
      const img = document.createElement("img");
      img.className = "tile-thumb";
      img.width = THUMB_SIZE;
      img.height = THUMB_SIZE;
      img.alt = "";
      img.title = title;
      img.src = dataUrl;
      return img;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "tile-thumb";
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    canvas.title = title;
    if (region) {
      try {
        drawTileThumb(canvas, region, arrows);
      } catch {
        // Malformed/irregular region -- leave the thumbnail blank rather
        // than breaking the whole tile manager.
      }
    }
    return canvas;
  }

  function renderTileRow(stem, type) {
    const entry = state.pool.get(stem);
    const alias = aliasForStem(stem, type);
    const style = styleOf(stem, alias);
    const isDisabled = state.disabled.has(stem);

    const row = document.createElement("div");
    row.className = "tile-row" + (isDisabled ? " tile-row-disabled" : "");

    const region = entry.doc.regions[0];
    row.appendChild(renderTileThumbEl(region, type));

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

    const rotateBtn = document.createElement("button");
    rotateBtn.type = "button";
    rotateBtn.className = "tile-rotate";
    rotateBtn.title = "Rotate 90° clockwise";
    rotateBtn.textContent = "↻";
    rotateBtn.addEventListener("click", () => {
      const current = state.pool.get(stem);
      if (!current) return;
      let rotated, bytes;
      try {
        rotated = rotateDoc(current.doc);
        // Recompute the tile's uncompressed NBT bytes from the rotated
        // region, so a subsequent "Save as theme…" persists the rotation
        // (state.pool.bytes must always match state.pool.doc).
        const assembly = assemblyFromRegion(rotated.regions[0]);
        bytes = writeLitematic({ ...assembly, name: stem, author: "maze2schematic-web", timestamp: Date.now() });
      } catch (err) {
        addMessage(`${stem}: rotate failed: ${err.message}`, "error");
        return;
      }
      applyPoolChange(() => {
        state.pool.set(stem, { ...current, doc: rotated, bytes });
      });
    });
    row.appendChild(rotateBtn);

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
  // Tile import modal: after parsing, the user explicitly chooses each
  // file's tile type + optional variant name (rather than relying on the
  // filename matching an alias). Plain div overlay, no external libs.
  // ---------------------------------------------------------------------

  /** Opens the import modal for a batch of already-parsed files
   * (`{stem, filename, doc}`, `stem` = original filename without
   * ".litematic", used only to prefill the row's type/variant guess).
   * "Import" builds the pool stem from the chosen canonical type (+
   * optional sanitized variant) for every row and applies them as one
   * `applyPoolChange` batch -- so a batch that fails to build (TileError)
   * is reverted as a whole, same as any other pool mutation. */
  function openTileImportModal(parsedFiles) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const card = document.createElement("div");
    card.className = "modal-card";
    overlay.appendChild(card);

    const title = document.createElement("h3");
    title.className = "modal-title";
    title.textContent = "Import tiles";
    card.appendChild(title);

    const topHint = document.createElement("p");
    topHint.className = "modal-hint";
    topHint.textContent =
      "Orientation matters: tiles must be saved in this canonical orientation " +
      "(north = −Z in Litematica). Use the rotate button after import if needed.";
    card.appendChild(topHint);

    const list = document.createElement("div");
    list.className = "tile-import-list";
    card.appendChild(list);

    const rows = parsedFiles.map(({ stem, filename, doc, bytes }) => {
      const canonical = typeForStem(stem);
      const variantGuess = canonical ? sanitizeVariant(styleOf(stem, aliasForStem(stem, canonical))) : "";

      const row = document.createElement("div");
      row.className = "tile-import-row";
      list.appendChild(row);

      const nameEl = document.createElement("div");
      nameEl.className = "tile-import-filename";
      nameEl.textContent = filename;
      row.appendChild(nameEl);

      const fields = document.createElement("div");
      fields.className = "tile-import-fields";
      row.appendChild(fields);

      const typeLabel = document.createElement("label");
      typeLabel.className = "tile-import-field";
      const typeSpan = document.createElement("span");
      typeSpan.textContent = "Type";
      typeLabel.appendChild(typeSpan);
      const select = document.createElement("select");
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "choose type";
      select.appendChild(placeholder);
      for (const name of TILE_NAMES) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      select.value = canonical ?? "";
      typeLabel.appendChild(select);
      fields.appendChild(typeLabel);

      const variantLabel = document.createElement("label");
      variantLabel.className = "tile-import-field";
      const variantSpan = document.createElement("span");
      variantSpan.textContent = "Variant";
      variantLabel.appendChild(variantSpan);
      const variantInput = document.createElement("input");
      variantInput.type = "text";
      variantInput.placeholder = "optional";
      variantInput.value = variantGuess;
      variantLabel.appendChild(variantInput);
      fields.appendChild(variantLabel);

      const hintEl = document.createElement("p");
      hintEl.className = "tile-import-hint";
      hintEl.textContent = canonical ? TYPE_ORIENTATION_HINTS[canonical] : "";
      row.appendChild(hintEl);

      select.addEventListener("change", () => {
        hintEl.textContent = select.value ? TYPE_ORIENTATION_HINTS[select.value] : "";
        updateImportButton();
      });

      return { filename, doc, bytes, select, variantInput };
    });

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    card.appendChild(actions);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => overlay.remove());
    actions.appendChild(cancelBtn);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "primary";
    importBtn.textContent = "Import";
    actions.appendChild(importBtn);

    function updateImportButton() {
      importBtn.disabled = rows.some((r) => !r.select.value);
    }
    updateImportButton();

    importBtn.addEventListener("click", () => {
      const entries = rows.map(({ doc, bytes, select, variantInput }) => {
        const canonical = select.value;
        const variant = sanitizeVariant(variantInput.value.trim());
        const stem = variant ? `${canonical}_${variant}` : canonical;
        // Bytes stay as-is (renaming only changes filename/stem, not the
        // tile's content), see the header comment on `state.pool`.
        return { stem, filename: `${stem}.litematic`, doc, bytes };
      });
      overlay.remove();
      const ok = applyPoolChange(() => {
        for (const { stem, filename, doc, bytes } of entries) {
          state.pool.set(stem, { filename, doc, bytes, source: "user" });
        }
      });
      if (ok) {
        addMessage(`${entries.length} tile${entries.length === 1 ? "" : "s"} imported.`, "info");
      }
    });

    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------
  // Adding tiles: drag & drop and the file-picker button both funnel
  // through this one function, which parses every file and then hands the
  // successfully-parsed ones to the import modal above (classification --
  // type + variant -- is chosen there, not derived from the filename).
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
      let doc, bytes;
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        bytes = await gunzip(raw); // uncompressed NBT bytes, kept for theme serialization
        doc = parseLitematic(bytes);
      } catch (err) {
        addMessage(`${file.name}: ${err.message}`, "error");
        continue;
      }
      for (const warning of doc.warnings) {
        addMessage(`${file.name}: ${warning}`, "warning");
      }
      const stem = file.name.replace(/\.litematic$/i, "");
      parsed.push({ stem, filename: file.name, doc, bytes });
    }

    if (parsed.length === 0) return;

    openTileImportModal(parsed);
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

  els.tileReset.addEventListener("click", async () => {
    if (state.activeTheme === null) {
      addMessage("No theme available.", "warning");
      return;
    }
    if (await selectTheme(state.activeTheme)) {
      addMessage("Theme reset.", "info");
    }
  });

  // ---------------------------------------------------------------------
  // Themes (task 9, extended): named tile sets. Built-in themes ship as
  // static assets under web/themes/ (manifest at web/themes/index.json,
  // see scripts/make_web_themes.py); user themes are saved in localStorage
  // via ./themes.js's serializeTheme/deserializeTheme. Switching the active
  // theme only rebuilds the pool/tileset/assembly -- state.maze (and its
  // seed) is left untouched, so restyling a maze via the dropdown is
  // instant and never regenerates the layout.
  // ---------------------------------------------------------------------

  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined" && localStorage !== null;
    } catch {
      return false; // some private-mode browsers throw on access, not just on read/write
    }
  }

  function persistActiveTheme(id) {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(LS_ACTIVE_THEME_KEY, id);
    } catch {
      addMessage("Could not save theme (storage unavailable or full).", "warning");
    }
  }

  /** Writes state.userThemes to localStorage. Returns whether it succeeded;
   * callers should abort the save/delete flow (without mutating
   * state.activeTheme etc.) when this returns false, since state.userThemes
   * would otherwise disagree with what's actually persisted. */
  function persistUserThemes() {
    if (!hasLocalStorage()) {
      addMessage("Could not save theme (storage unavailable or full).", "warning");
      return false;
    }
    try {
      const serialized = [...state.userThemes.values()].map((theme) => serializeTheme(theme));
      localStorage.setItem(LS_USER_THEMES_KEY, JSON.stringify(serialized));
      return true;
    } catch {
      addMessage("Could not save theme (storage unavailable or full).", "warning");
      return false;
    }
  }

  /** Reads + deserializes state.userThemes from localStorage. A theme that
   * fails to deserialize (corrupted JSON/base64/structure) is skipped with
   * a message rather than aborting startup entirely. */
  function loadUserThemesFromStorage() {
    state.userThemes = new Map();
    if (!hasLocalStorage()) return;
    let raw;
    try {
      raw = localStorage.getItem(LS_USER_THEMES_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      addMessage("Stored themes could not be read (corrupted data) and were skipped.", "warning");
      return;
    }
    if (!Array.isArray(list)) return;
    for (const item of list) {
      try {
        const theme = deserializeTheme(item);
        state.userThemes.set(theme.id, theme);
      } catch (err) {
        addMessage(`A stored theme could not be loaded and was skipped: ${err.message}`, "warning");
      }
    }
  }

  function readStoredActiveTheme() {
    if (!hasLocalStorage()) return null;
    try {
      return localStorage.getItem(LS_ACTIVE_THEME_KEY);
    } catch {
      return null;
    }
  }

  /** Lowercase `[a-z0-9-]+` slug used as a user theme's id, derived from its
   * display name -- so re-saving under the same (or differently-cased/
   * punctuated) name overwrites the existing entry, per spec. */
  function slugifyThemeName(label) {
    return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
  }

  /** Fetches + parses one built-in theme's tile files + variants config
   * into a fresh {pool, weights, disabled, clusters} snapshot. */
  async function fetchBuiltinTheme(meta) {
    const entries = await Promise.all(
      meta.files.map(async (relPath) => {
        const res = await fetch(`themes/${meta.dir}/${relPath}`);
        if (!res.ok) throw new Error(`${relPath}: HTTP ${res.status}`);
        const raw = new Uint8Array(await res.arrayBuffer());
        const bytes = await gunzip(raw); // uncompressed NBT bytes, kept for theme serialization
        const doc = parseLitematic(bytes);
        for (const warning of doc.warnings) {
          addMessage(`${relPath}: ${warning}`, "warning");
        }
        return { filename: relPath.split("/").pop(), doc, bytes };
      }),
    );

    let config = { weights: {}, clusters: {} };
    if (meta.variants) {
      const vres = await fetch(`themes/${meta.dir}/${meta.variants}`);
      if (vres.ok) {
        config = parseVariantsConfig(await vres.json());
      }
    }

    const pool = new Map();
    for (const { filename, doc, bytes } of entries) {
      const stem = filename.replace(/\.litematic$/i, "");
      pool.set(stem, { filename, doc, bytes, source: "preset" });
    }
    return {
      pool,
      weights: { ...config.weights },
      // Built-in themes can ship stems disabled by default (manifest
      // "disabled", e.g. the closed tile: solid cells stay empty then).
      disabled: new Set(meta.disabled ?? []),
      clusters: config.clusters,
    };
  }

  /** Builds a {pool, weights, disabled, clusters} snapshot from an
   * already-deserialized user theme (no network access -- tile bytes are
   * already in memory, see ./themes.js). Tiles loaded this way are marked
   * `source: "user"` regardless of their original origin: once saved into
   * a user theme, they're user data, not the built-in asset anymore. */
  function poolFromUserTheme(theme) {
    const pool = new Map();
    for (const { filename, bytes } of theme.tiles) {
      const stem = filename.replace(/\.litematic$/i, "");
      let doc;
      try {
        doc = parseLitematic(bytes);
      } catch (err) {
        throw new Error(`${filename}: ${err.message}`);
      }
      pool.set(stem, { filename, doc, bytes, source: "user" });
    }
    return {
      pool,
      weights: { ...theme.weights },
      disabled: new Set(theme.disabled),
      clusters: theme.clusters,
    };
  }

  /** Loads (or returns a cached/in-memory copy of) the {pool, weights,
   * disabled, clusters} snapshot for theme `id` -- a user theme (from
   * state.userThemes, no I/O) or a built-in theme (fetched once, then
   * cached in state.builtinThemeCache so switching back to a
   * previously-loaded built-in theme, or resetting it, doesn't refetch).
   * Always returns a fresh copy (new Map/Set) so callers can freely mutate
   * state.pool/weights/disabled without corrupting the cache. */
  async function loadThemeSnapshot(id) {
    const userTheme = state.userThemes.get(id);
    if (userTheme) return poolFromUserTheme(userTheme);

    const meta = state.themes.find((t) => t.id === id);
    if (!meta) throw new Error(`Unknown theme '${id}'.`);

    if (!state.builtinThemeCache.has(id)) {
      state.builtinThemeCache.set(id, await fetchBuiltinTheme(meta));
    }
    const cached = state.builtinThemeCache.get(id);
    return {
      pool: new Map(cached.pool),
      weights: { ...cached.weights },
      disabled: new Set(cached.disabled),
      clusters: cached.clusters,
    };
  }

  /** Activates theme `id`: loads its snapshot into state.pool/weights/
   * disabled/clusters, rebuilds the tile set, and re-renders the tile
   * manager + triggers a maze/assembly re-render (state.maze itself is
   * never touched -- see the header comment on this section). Persists the
   * choice to localStorage on success. Returns whether it succeeded; on
   * failure state.activeTheme is left unchanged and an error message is
   * shown (the caller is responsible for reverting any UI control, e.g.
   * the <select>'s value, that already reflects the failed attempt). */
  async function selectTheme(id) {
    let snapshot;
    try {
      snapshot = await loadThemeSnapshot(id);
    } catch (err) {
      addMessage(`Theme '${id}' could not be loaded: ${err.message}`, "error");
      return false;
    }

    state.activeTheme = id;
    state.pool = snapshot.pool;
    state.weights = snapshot.weights;
    state.disabled = snapshot.disabled;
    state.clusters = snapshot.clusters;
    state.themeModified = false;

    rebuildTileset();
    renderTileManager();
    populateThemeSelect();
    render();
    persistActiveTheme(id);
    return true;
  }

  /** Rebuilds the #theme-select <option>s from state.themes + userThemes,
   * appends " •" to the active theme's label if state.themeModified, and
   * enables #theme-delete only for a user theme. */
  function populateThemeSelect() {
    els.themeSelect.innerHTML = "";
    for (const meta of state.themes) {
      const opt = document.createElement("option");
      opt.value = meta.id;
      opt.textContent = meta.label + (meta.id === state.activeTheme && state.themeModified ? " •" : "");
      els.themeSelect.appendChild(opt);
    }
    for (const theme of state.userThemes.values()) {
      const opt = document.createElement("option");
      opt.value = theme.id;
      opt.textContent =
        `${theme.label} (custom)` + (theme.id === state.activeTheme && state.themeModified ? " •" : "");
      els.themeSelect.appendChild(opt);
    }
    if (state.activeTheme !== null) els.themeSelect.value = state.activeTheme;
    els.themeDelete.disabled = !state.userThemes.has(state.activeTheme);
  }

  els.themeSelect.addEventListener("change", async () => {
    const id = els.themeSelect.value;
    if (id === state.activeTheme) return;
    if (!(await selectTheme(id))) {
      populateThemeSelect(); // revert the <select>'s value to the still-active theme
    }
  });

  els.themeSave.addEventListener("click", () => {
    const raw = window.prompt("Save the current tile set as a theme -- name:", "");
    if (raw === null) return; // cancelled
    const label = raw.trim();
    if (!label) {
      addMessage("Theme name cannot be empty.", "warning");
      return;
    }
    const id = slugifyThemeName(label);
    if (state.themes.some((t) => t.id === id)) {
      addMessage(`"${label}" conflicts with a built-in theme name -- choose a different name.`, "error");
      return;
    }

    const overwriting = state.userThemes.has(id);
    const theme = {
      id,
      label,
      tiles: [...state.pool.values()].map(({ filename, bytes }) => ({ filename, bytes })),
      weights: { ...state.weights },
      disabled: [...state.disabled],
      clusters: state.clusters,
    };
    const previousThemes = new Map(state.userThemes);
    state.userThemes.set(id, theme);
    if (!persistUserThemes()) {
      state.userThemes = previousThemes; // revert -- nothing was actually saved
      return;
    }

    state.activeTheme = id;
    state.themeModified = false;
    persistActiveTheme(id);
    populateThemeSelect();
    addMessage(overwriting ? `Theme "${label}" updated.` : `Theme "${label}" saved.`, "info");
  });

  els.themeDelete.addEventListener("click", () => {
    const theme = state.userThemes.get(state.activeTheme);
    if (!theme) return; // button is disabled in this case, but guard anyway
    if (!window.confirm(`Delete theme "${theme.label}"? This cannot be undone.`)) return;

    const previousThemes = new Map(state.userThemes);
    state.userThemes.delete(theme.id);
    if (!persistUserThemes()) {
      state.userThemes = previousThemes;
      return;
    }
    addMessage(`Theme "${theme.label}" deleted.`, "info");
    selectTheme(state.themes.some((t) => t.id === FALLBACK_THEME_ID) ? FALLBACK_THEME_ID : state.themes[0]?.id ?? null);
  });

  /** Loads the built-in theme manifest + restores user themes/the last
   * active theme from localStorage, then activates a theme. Never throws:
   * a manifest fetch failure (e.g. `file://`) leaves state.themes empty and
   * only shows a warning -- drag & drop still works, and a stored user
   * theme (no network needed) can still become active. */
  async function loadThemes() {
    loadUserThemesFromStorage();

    try {
      const res = await fetch("themes/index.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      state.themes = manifest.themes ?? [];
    } catch {
      state.themes = [];
      addMessage(
        "Themes could not be loaded (requires an HTTP(S) server, e.g. " +
          "`python3 -m http.server` -- opening via file:// doesn't work). " +
          "Adding your own tiles (drag & drop or the Add tiles button) still works.",
        "warning",
      );
    }

    const stored = readStoredActiveTheme();
    const knownIds = new Set([...state.themes.map((t) => t.id), ...state.userThemes.keys()]);
    const fallback = state.themes.some((t) => t.id === FALLBACK_THEME_ID)
      ? FALLBACK_THEME_ID
      : (state.themes[0]?.id ?? [...state.userThemes.keys()][0] ?? null);
    const initial = stored && knownIds.has(stored) ? stored : fallback;

    state.activeTheme = initial;
    populateThemeSelect();
    if (initial !== null) {
      await selectTheme(initial);
    } else {
      renderTileManager(); // nothing to load -- still show the (empty) tile manager
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
  loadThemes();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
