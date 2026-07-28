// 3D voxel preview: builds a single BufferGeometry mesh from the assembly
// model (task 7) with manual face culling (only faces whose neighbor is
// air/outside are emitted) and renders it with three.js (vendored in
// web/vendor/, see web/vendor/LICENSE-three.txt).
//
// The pure geometry computation (`buildGeometryData`) is deliberately
// decoupled from THREE -- it knows neither `THREE.BufferGeometry` nor
// anything else from three.js, only returning flat TypedArrays. That makes
// it testable in Node without WebGL/DOM (see web/test/preview3d.test.js),
// and the rest of this module (scene, renderer, camera, render loop)
// remains pure "glue" between this function and three.js.
//
// Module load-time constraint (like preview2d.js/main.js): no `document`/
// `window`/WebGL access outside of function bodies. The static import of
// three.module.js/OrbitControls.js is unproblematic since neither file
// touches the DOM on import itself (only inside their classes/functions)
// -- verified via `node -e "import(...)"`.

import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { colorForBlock } from "./preview2d.js";

// A footprint larger than this cell count (sizeX * sizeZ) disables the 3D
// view (performance guard from the brief: ~ >200x200 cells at 5-wide tiles).
export const MAX_FOOTPRINT_CELLS = 1_000_000;

const TOO_LARGE_MESSAGE = "3D view disabled for this size";

// ---------------------------------------------------------------------------
// Pure geometry generation (no THREE, testable in Node)
// ---------------------------------------------------------------------------

// Six cube faces: `normal` points outward, `neighbor` is the cell offset
// whose air/outside state makes the face visible, `verts` are the four
// vertex offsets (0/1 per axis) relative to the block corner (x, y, z) in
// an order that, for triangles (0,1,2) and (0,2,3) via cross product
// (v1-v0) x (v2-v1), yields exactly `normal` (outward-facing winding
// order, see task-12-report.md).
const FACES = [
  { normal: [1, 0, 0], neighbor: [1, 0, 0], verts: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }, // +X
  { normal: [-1, 0, 0], neighbor: [-1, 0, 0], verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -X
  { normal: [0, 1, 0], neighbor: [0, 1, 0], verts: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // +Y
  { normal: [0, -1, 0], neighbor: [0, -1, 0], verts: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
  { normal: [0, 0, 1], neighbor: [0, 0, 1], verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { normal: [0, 0, -1], neighbor: [0, 0, -1], verts: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }, // -Z
];

/** Parses a CSS color returned by `colorForBlock` (`#rrggbb` or
 * `hsl(h, s%, l%)`) into `[r, g, b]` in [0, 1]. Deliberately without
 * THREE.Color, so `buildGeometryData` stays THREE-free. Unknown formats
 * return white. */
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

/** Builds the merged voxel geometry for an assembly (task 7). For every
 * non-air block, only the faces whose neighbor is air or outside the
 * assembly are emitted (manual face culling -- no interior-face
 * artifacts, far fewer triangles than one cube per block). Returns flat
 * TypedArrays, directly suitable for `BufferGeometry.setAttribute`/
 * `setIndex`; contains no THREE object. */
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
// THREE wiring (scene, renderer, render loop) -- all behind function calls,
// no DOM/WebGL access at module load time.
// ---------------------------------------------------------------------------

let _sceneState = null; // { renderer, scene, camera, controls, mesh, container, active, rafId, pendingAssembly }

/** Creates renderer/scene/camera/controls for `container` (typically
 * `#view-3d`). Called lazily from main.js the first time the 3D tab is
 * activated (avoids creating a WebGL context as long as the tab is never
 * clicked). Repeat calls are a no-op (returns the existing state). */
export function initScene(container) {
  if (_sceneState) return _sceneState;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d22); // matches --bg in style.css

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
    lastSize: null, // { x, y, z } of the last applied assembly size
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

/** Disposes the old mesh (geometry + material) and builds a new one from
 * `assembly` -- or, if the footprint is too large (`sizeX * sizeZ >
 * MAX_FOOTPRINT_CELLS`), shows a message in `container` instead of a mesh.
 * Can be called before `initScene` has ever run (e.g. if the 3D tab has
 * never been active) -- in that case it just remembers the assembly and
 * builds it on the next `initScene`/`setActive(true)`. */
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

  // Only reposition the camera/controls target if the dimensions have
  // changed since the last updateScene call -- otherwise every small
  // parameter change (e.g. a slider nudge) would reset the user's view
  // even though the size hasn't actually changed.
  const dimsChanged =
    !state.lastSize ||
    state.lastSize.x !== assembly.sizeX ||
    state.lastSize.y !== assembly.sizeY ||
    state.lastSize.z !== assembly.sizeZ;
  if (dimsChanged) {
    const cx = assembly.sizeX / 2;
    const cy = assembly.sizeY / 2;
    const cz = assembly.sizeZ / 2;
    state.controls.target.set(cx, cy, cz);
    const maxDim = Math.max(assembly.sizeX, assembly.sizeY, assembly.sizeZ);
    state.camera.position.set(cx + maxDim, cy + maxDim, cz + maxDim);
    state.lastSize = { x: assembly.sizeX, y: assembly.sizeY, z: assembly.sizeZ };
  }
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

/** Activates/deactivates the render loop (`requestAnimationFrame`) so the
 * 3D view only renders while the 3D tab is visible. On the first
 * `setActive(true)` (or if `initScene` hasn't run yet), the scene is
 * initialized lazily and any `updateScene` assembly that arrived before
 * initialization is applied. */
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

/** Calls `_resize` again, e.g. on `window.resize` or a tab switch
 * (container size has changed). No-op before `initScene`. */
export function handleResize() {
  _resize();
}

/** Test-only: resets the internal module state. */
export function _resetForTests() {
  _sceneState = null;
  _pendingAssemblyBeforeInit = undefined;
}
