import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeometryData, parseCssColor, MAX_FOOTPRINT_CELLS } from "../js/preview3d.js";
import { colorForBlock } from "../js/preview2d.js";

// ---------------------------------------------------------------------------
// Helper: builds an assembly object like assemble.js returns
// (sizeX/sizeY/sizeZ, palette: [{id, props}], blocks: Uint32Array, index
// (y*sizeZ+z)*sizeX+x). `cells` is a list of {x,y,z,id}; everything else
// stays palette[0] = air.
// ---------------------------------------------------------------------------

function makeAssembly(sizeX, sizeY, sizeZ, cells) {
  const palette = [{ id: "minecraft:air", props: {} }];
  const idFor = (id) => {
    let idx = palette.findIndex((s) => s.id === id);
    if (idx === -1) {
      palette.push({ id, props: {} });
      idx = palette.length - 1;
    }
    return idx;
  };
  const blocks = new Uint32Array(sizeX * sizeY * sizeZ); // default 0 = air
  for (const { x, y, z, id } of cells) {
    blocks[(y * sizeZ + z) * sizeX + x] = idFor(id);
  }
  return { sizeX, sizeY, sizeZ, palette, blocks };
}

// ---------------------------------------------------------------------------
// buildGeometryData: basic face-culling cases
// ---------------------------------------------------------------------------

test("buildGeometryData: single block in 1x1x1 -> 6 faces (24 vertices, 36 indices)", () => {
  const assembly = makeAssembly(1, 1, 1, [{ x: 0, y: 0, z: 0, id: "minecraft:stone" }]);
  const data = buildGeometryData(assembly);

  assert.equal(data.positions.length / 3, 24); // 6 faces * 4 vertices
  assert.equal(data.normals.length / 3, 24);
  assert.equal(data.colors.length / 3, 24);
  assert.equal(data.indices.length, 36); // 6 faces * 6 indices (2 triangles)
  assert.equal(data.indexCount, 36);
});

test("buildGeometryData: two adjacent blocks in 2x1x1 -> 10 faces (shared face culled on both sides)", () => {
  const assembly = makeAssembly(2, 1, 1, [
    { x: 0, y: 0, z: 0, id: "minecraft:stone" },
    { x: 1, y: 0, z: 0, id: "minecraft:stone" },
  ]);
  const data = buildGeometryData(assembly);

  // Without culling this would be 12 faces (2 * 6); the two faces facing
  // each other (+X of block 0, -X of block 1) are dropped -> 10.
  assert.equal(data.positions.length / 3, 40); // 10 * 4
  assert.equal(data.indices.length, 60); // 10 * 6
  assert.equal(data.indexCount, 60);
});

test("buildGeometryData: pure air assembly (1x1x1) -> 0 faces", () => {
  const assembly = makeAssembly(1, 1, 1, []);
  const data = buildGeometryData(assembly);

  assert.equal(data.positions.length, 0);
  assert.equal(data.normals.length, 0);
  assert.equal(data.colors.length, 0);
  assert.equal(data.indices.length, 0);
  assert.equal(data.indexCount, 0);
});

test("buildGeometryData: empty/invalid assembly doesn't crash", () => {
  assert.equal(buildGeometryData(null).indexCount, 0);
  assert.equal(buildGeometryData({ sizeX: 0, sizeY: 0, sizeZ: 0, palette: [], blocks: new Uint32Array(0) }).indexCount, 0);
});

// ---------------------------------------------------------------------------
// Color assignment: all 4 vertices of a face share the block color
// ---------------------------------------------------------------------------

test("buildGeometryData: face color matches colorForBlock (all 4 vertices equal)", () => {
  const assembly = makeAssembly(1, 1, 1, [{ x: 0, y: 0, z: 0, id: "minecraft:stone" }]);
  const data = buildGeometryData(assembly);
  const [r, g, b] = parseCssColor(colorForBlock("minecraft:stone"));

  for (let v = 0; v < data.colors.length / 3; v++) {
    assert.ok(Math.abs(data.colors[v * 3] - r) < 1e-6, `vertex ${v} r`);
    assert.ok(Math.abs(data.colors[v * 3 + 1] - g) < 1e-6, `vertex ${v} g`);
    assert.ok(Math.abs(data.colors[v * 3 + 2] - b) < 1e-6, `vertex ${v} b`);
  }
});

test("buildGeometryData: different blocks get different vertex colors", () => {
  const assembly = makeAssembly(2, 1, 1, [
    { x: 0, y: 0, z: 0, id: "minecraft:stone" },
    { x: 1, y: 0, z: 0, id: "minecraft:oak_log" },
  ]);
  const data = buildGeometryData(assembly);
  const stoneRgb = parseCssColor(colorForBlock("minecraft:stone"));
  const logRgb = parseCssColor(colorForBlock("minecraft:oak_log"));
  assert.notDeepEqual(stoneRgb, logRgb);

  // Every vertex color value must match exactly one of the two block colors.
  for (let v = 0; v < data.colors.length / 3; v++) {
    const c = [data.colors[v * 3], data.colors[v * 3 + 1], data.colors[v * 3 + 2]];
    const matchesStone = c.every((val, i) => Math.abs(val - stoneRgb[i]) < 1e-6);
    const matchesLog = c.every((val, i) => Math.abs(val - logRgb[i]) < 1e-6);
    assert.ok(matchesStone || matchesLog, `vertex ${v} color ${c} matches neither block`);
  }
});

// ---------------------------------------------------------------------------
// Normals: identical per face, matching one of the 6 axis directions
// ---------------------------------------------------------------------------

test("buildGeometryData: each face has a uniform axis normal across all 4 vertices", () => {
  const assembly = makeAssembly(1, 1, 1, [{ x: 0, y: 0, z: 0, id: "minecraft:stone" }]);
  const data = buildGeometryData(assembly);
  const axisNormals = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let face = 0; face < 6; face++) {
    const base = face * 4;
    const n0 = [data.normals[base * 3], data.normals[base * 3 + 1], data.normals[base * 3 + 2]];
    assert.ok(axisNormals.some((an) => an.every((v, i) => v === n0[i])), `face ${face} normal ${n0} not axis-aligned`);
    for (let v = 1; v < 4; v++) {
      const idx = (base + v) * 3;
      assert.deepEqual([data.normals[idx], data.normals[idx + 1], data.normals[idx + 2]], n0);
    }
  }
});

// ---------------------------------------------------------------------------
// parseCssColor
// ---------------------------------------------------------------------------

test("parseCssColor: hex colors are correctly converted to [0,1] RGB", () => {
  assert.deepEqual(parseCssColor("#ffffff"), [1, 1, 1]);
  assert.deepEqual(parseCssColor("#000000"), [0, 0, 0]);
  const [r, g, b] = parseCssColor("#8a8a8a");
  assert.ok(Math.abs(r - 0x8a / 255) < 1e-9);
  assert.ok(Math.abs(g - 0x8a / 255) < 1e-9);
  assert.ok(Math.abs(b - 0x8a / 255) < 1e-9);
});

test("parseCssColor: hsl(...) colors (fallback from colorForBlock) are parsed", () => {
  const [r, g, b] = parseCssColor("hsl(0, 100%, 50%)"); // pure red
  assert.ok(Math.abs(r - 1) < 1e-6);
  assert.ok(Math.abs(g - 0) < 1e-6);
  assert.ok(Math.abs(b - 0) < 1e-6);
});

test("MAX_FOOTPRINT_CELLS matches the value specified in the brief (1_000_000)", () => {
  assert.equal(MAX_FOOTPRINT_CELLS, 1_000_000);
});
