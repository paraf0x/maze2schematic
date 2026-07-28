// 3D-Voxel-Vorschau: baut aus dem Assembly-Modell (Task 7) ein einziges
// BufferGeometry-Mesh mit manuellem Face-Culling (nur Flaechen, deren
// Nachbar Luft/ausserhalb ist, werden emittiert) und rendert es mit
// three.js (vendort in web/vendor/, siehe web/vendor/LICENSE-three.txt).
//
// Die reine Geometrie-Berechnung (`buildGeometryData`) ist bewusst von THREE
// entkoppelt -- sie kennt weder `THREE.BufferGeometry` noch sonst etwas aus
// three.js, sondern liefert nur flache TypedArrays. Dadurch ist sie in Node
// ohne WebGL/DOM testbar (siehe web/test/preview3d.test.js) und der Rest
// dieses Moduls (Szene, Renderer, Kamera, Render-Loop) bleibt reiner
// "Kleber" zwischen dieser Funktion und three.js.
//
// Modul-Ladezeit-Konstraint (wie preview2d.js/main.js): kein `document`/
// `window`/WebGL-Zugriff ausserhalb von Funktionskoerpern. Der statische
// Import von three.module.js/OrbitControls.js ist unproblematisch, da beide
// Dateien selbst beim Import keinen DOM-Zugriff ausfuehren (nur innerhalb
// ihrer Klassen/Funktionen) -- verifiziert per `node -e "import(...)"`.

import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { colorForBlock } from "./preview2d.js";

// Blockgroesse > diese Zellenzahl (sizeX * sizeZ) deaktiviert die 3D-Ansicht
// (Performance-Guard aus dem Brief: ~ >200x200 Zellen bei 5er-Tiles).
export const MAX_FOOTPRINT_CELLS = 1_000_000;

const TOO_LARGE_MESSAGE = "3D-Ansicht für diese Größe deaktiviert";

// ---------------------------------------------------------------------------
// Reine Geometrie-Erzeugung (kein THREE, in Node testbar)
// ---------------------------------------------------------------------------

// Sechs Wuerfelflaechen: `normal` zeigt nach aussen, `neighbor` ist der
// Zellenoffset, dessen Luft-/Ausserhalb-Zustand die Flaeche sichtbar macht,
// `verts` sind die vier Eckpunkt-Offsets (0/1 je Achse) relativ zur
// Blockecke (x, y, z) in einer Reihenfolge, die bei Dreiecken (0,1,2) und
// (0,2,3) via Kreuzprodukt (v1-v0) x (v2-v1) exakt `normal` ergibt (nach
// aussen zeigende Winding-Reihenfolge, s. task-12-report.md).
const FACES = [
  { normal: [1, 0, 0], neighbor: [1, 0, 0], verts: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }, // +X
  { normal: [-1, 0, 0], neighbor: [-1, 0, 0], verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -X
  { normal: [0, 1, 0], neighbor: [0, 1, 0], verts: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // +Y
  { normal: [0, -1, 0], neighbor: [0, -1, 0], verts: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
  { normal: [0, 0, 1], neighbor: [0, 0, 1], verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { normal: [0, 0, -1], neighbor: [0, 0, -1], verts: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }, // -Z
];

/** Parst eine von `colorForBlock` gelieferte CSS-Farbe (`#rrggbb` oder
 * `hsl(h, s%, l%)`) zu `[r, g, b]` in [0, 1]. Bewusst ohne THREE.Color, damit
 * `buildGeometryData` THREE-frei bleibt. Unbekannte Formate liefern Weiss. */
export function parseCssColor(css) {
  if (typeof css !== "string") return [1, 1, 1];
  const hex = /^#([0-9a-fA-F]{6})$/.exec(css.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(css.trim());
  if (hsl) {
    const h = (Number(hsl[1]) % 360) / 360;
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    return _hslToRgb(h, s, l);
  }
  return [1, 1, 1];
}

function _hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [_hueToRgb(p, q, h + 1 / 3), _hueToRgb(p, q, h), _hueToRgb(p, q, h - 1 / 3)];
}

function _hueToRgb(p, q, t) {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/** Baut die gemergte Voxel-Geometrie fuer ein Assembly (Task 7). Fuer jeden
 * Nicht-Luft-Block werden nur die Flaechen emittiert, deren Nachbar Luft
 * oder ausserhalb der Assembly liegt (manuelles Face-Culling -- keine
 * Innenflaechen-Artefakte, deutlich weniger Dreiecke als ein Wuerfel pro
 * Block). Liefert flache TypedArrays, direkt geeignet fuer
 * `BufferGeometry.setAttribute`/`setIndex`; enthaelt kein THREE-Objekt. */
export function buildGeometryData(assembly) {
  const empty = () => ({
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
    indexCount: 0,
  });
  if (!assembly) return empty();
  const { sizeX, sizeY, sizeZ, palette, blocks } = assembly;
  if (!(sizeX > 0) || !(sizeY > 0) || !(sizeZ > 0)) return empty();

  const blockIndex = (x, y, z) => (y * sizeZ + z) * sizeX + x;
  const isAir = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= sizeX || y >= sizeY || z >= sizeZ) return true;
    const idx = blocks[blockIndex(x, y, z)];
    const state = palette[idx];
    return !state || state.id === "minecraft:air";
  };

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertCount = 0;
  const colorCache = new Map();

  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const idx = blocks[blockIndex(x, y, z)];
        const state = palette[idx];
        if (!state || state.id === "minecraft:air") continue;

        let rgb = colorCache.get(state.id);
        if (!rgb) {
          rgb = parseCssColor(colorForBlock(state.id));
          colorCache.set(state.id, rgb);
        }
        const [r, g, b] = rgb;

        for (const face of FACES) {
          const [nx, ny, nz] = face.neighbor;
          if (!isAir(x + nx, y + ny, z + nz)) continue;

          for (const [ox, oy, oz] of face.verts) {
            positions.push(x + ox, y + oy, z + oz);
            normals.push(face.normal[0], face.normal[1], face.normal[2]);
            colors.push(r, g, b);
          }
          indices.push(vertCount, vertCount + 1, vertCount + 2, vertCount, vertCount + 2, vertCount + 3);
          vertCount += 4;
        }
      }
    }
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
    indexCount: indices.length,
  };
}

// ---------------------------------------------------------------------------
// THREE-Verdrahtung (Szene, Renderer, Render-Loop) -- alles hinter
// Funktionsaufrufen, kein DOM-/WebGL-Zugriff zur Modul-Ladezeit.
// ---------------------------------------------------------------------------

let _sceneState = null; // { renderer, scene, camera, controls, mesh, container, active, rafId, pendingAssembly }

/** Erstellt Renderer/Szene/Kamera/Controls fuer `container` (typischerweise
 * `#view-3d`). Wird lazy beim ersten Aktivieren des 3D-Tabs aus main.js
 * aufgerufen (vermeidet WebGL-Kontext-Erzeugung, solange der Tab nie
 * angeklickt wird). Mehrfachaufruf ist ein No-Op (liefert den bestehenden
 * State zurueck). */
export function initScene(container) {
  if (_sceneState) return _sceneState;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d22); // entspricht --bg aus style.css

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
  camera.position.set(10, 15, 20);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  container.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(30, 50, 20);
  scene.add(ambient, directional);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  _sceneState = {
    renderer,
    scene,
    camera,
    controls,
    mesh: null,
    container,
    active: false,
    rafId: null,
    pendingAssembly: undefined,
  };

  _resize();
  return _sceneState;
}

function _resize() {
  if (!_sceneState) return;
  const { renderer, camera, container } = _sceneState;
  const width = container.clientWidth || 1;
  const height = container.clientHeight || 1;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

/** Disposed das alte Mesh (Geometrie + Material) und baut ein neues aus
 * `assembly` -- oder zeigt bei zu grosser Grundflaeche (`sizeX * sizeZ >
 * MAX_FOOTPRINT_CELLS`) stattdessen eine Meldung in `container` statt eines
 * Mesh. Kann aufgerufen werden, bevor `initScene` je lief (z.B. wenn der
 * 3D-Tab noch nie aktiv war) -- merkt sich das Assembly dann nur und baut es
 * beim naechsten `initScene`/`setActive(true)` nach. */
export function updateScene(assembly) {
  if (!_sceneState) {
    _pendingAssemblyBeforeInit = assembly;
    return;
  }
  _applyAssembly(assembly);
}

let _pendingAssemblyBeforeInit = undefined;

function _applyAssembly(assembly) {
  const state = _sceneState;
  if (!state) return;

  if (state.mesh) {
    state.scene.remove(state.mesh);
    state.mesh.geometry.dispose();
    state.mesh.material.dispose();
    state.mesh = null;
  }
  _clearMessage(state.container);

  if (!assembly || !(assembly.sizeX > 0) || !(assembly.sizeY > 0) || !(assembly.sizeZ > 0)) {
    return;
  }

  if (assembly.sizeX * assembly.sizeZ > MAX_FOOTPRINT_CELLS) {
    _showMessage(state.container, TOO_LARGE_MESSAGE);
    return;
  }

  const data = buildGeometryData(assembly);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  state.scene.add(mesh);
  state.mesh = mesh;

  const cx = assembly.sizeX / 2;
  const cy = assembly.sizeY / 2;
  const cz = assembly.sizeZ / 2;
  state.controls.target.set(cx, cy, cz);
  const maxDim = Math.max(assembly.sizeX, assembly.sizeY, assembly.sizeZ);
  state.camera.position.set(cx + maxDim, cy + maxDim, cz + maxDim);
  state.controls.update();
}

function _showMessage(container, text) {
  let el = container.querySelector("[data-preview3d-message]");
  if (!el) {
    el = document.createElement("div");
    el.setAttribute("data-preview3d-message", "");
    el.className = "view3d-message";
    container.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "";
}

function _clearMessage(container) {
  const el = container.querySelector("[data-preview3d-message]");
  if (el) el.style.display = "none";
}

/** Aktiviert/deaktiviert den Render-Loop (`requestAnimationFrame`), damit
 * die 3D-Ansicht nur rendert, waehrend der 3D-Tab sichtbar ist. Beim ersten
 * `setActive(true)` (oder falls `initScene` noch nicht lief) wird die Szene
 * lazy initialisiert und ein evtl. vor der Initialisierung angekommenes
 * `updateScene`-Assembly nachgeholt. */
export function setActive(container, active) {
  if (active && !_sceneState) {
    initScene(container);
    if (_pendingAssemblyBeforeInit !== undefined) {
      _applyAssembly(_pendingAssemblyBeforeInit);
      _pendingAssemblyBeforeInit = undefined;
    }
  }
  if (!_sceneState) return;

  _sceneState.active = active;
  if (active) {
    _resize();
    _startLoop();
  } else {
    _stopLoop();
  }
}

function _startLoop() {
  const state = _sceneState;
  if (!state || state.rafId !== null) return;
  const tick = () => {
    if (!state.active) {
      state.rafId = null;
      return;
    }
    state.controls.update();
    state.renderer.render(state.scene, state.camera);
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function _stopLoop() {
  const state = _sceneState;
  if (!state) return;
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

/** Ruft `_resize` erneut auf, z.B. bei `window.resize` oder Tab-Wechsel
 * (Container-Groesse hat sich veraendert). No-Op vor `initScene`. */
export function handleResize() {
  _resize();
}

/** Nur fuer Tests: setzt den internen Modul-State zurueck. */
export function _resetForTests() {
  _sceneState = null;
  _pendingAssemblyBeforeInit = undefined;
}
