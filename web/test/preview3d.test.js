import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeometryData, parseCssColor, MAX_FOOTPRINT_CELLS } from "../js/preview3d.js";
import { colorForBlock } from "../js/preview2d.js";

// ---------------------------------------------------------------------------
// Hilfsfunktion: baut ein Assembly-Objekt wie assemble.js es liefert
// (sizeX/sizeY/sizeZ, palette: [{id, props}], blocks: Uint32Array, Index
// (y*sizeZ+z)*sizeX+x). `cells` ist eine Liste von {x,y,z,id}; alles andere
// bleibt palette[0] = air.
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
// buildGeometryData: Face-Culling-Grundfaelle
// ---------------------------------------------------------------------------

test("buildGeometryData: einzelner Block in 1x1x1 -> 6 Flaechen (24 Vertices, 36 Indices)", () => {
  const assembly = makeAssembly(1, 1, 1, [{ x: 0, y: 0, z: 0, id: "minecraft:stone" }]);
  const data = buildGeometryData(assembly);

  assert.equal(data.positions.length / 3, 24); // 6 Flaechen * 4 Vertices
  assert.equal(data.normals.length / 3, 24);
  assert.equal(data.colors.length / 3, 24);
  assert.equal(data.indices.length, 36); // 6 Flaechen * 6 Indices (2 Dreiecke)
  assert.equal(data.indexCount, 36);
});

test("buildGeometryData: zwei benachbarte Bloecke in 2x1x1 -> 10 Flaechen (gemeinsame Flaeche beidseitig gekuellt)", () => {
  const assembly = makeAssembly(2, 1, 1, [
    { x: 0, y: 0, z: 0, id: "minecraft:stone" },
    { x: 1, y: 0, z: 0, id: "minecraft:stone" },
  ]);
  const data = buildGeometryData(assembly);

  // Ohne Culling waeren es 12 Flaechen (2 * 6); die beiden einander
  // zugewandten Flaechen (+X von Block 0, -X von Block 1) entfallen -> 10.
  assert.equal(data.positions.length / 3, 40); // 10 * 4
  assert.equal(data.indices.length, 60); // 10 * 6
  assert.equal(data.indexCount, 60);
});

test("buildGeometryData: reine Luft-Assembly (1x1x1) -> 0 Flaechen", () => {
  const assembly = makeAssembly(1, 1, 1, []);
  const data = buildGeometryData(assembly);

  assert.equal(data.positions.length, 0);
  assert.equal(data.normals.length, 0);
  assert.equal(data.colors.length, 0);
  assert.equal(data.indices.length, 0);
  assert.equal(data.indexCount, 0);
});

test("buildGeometryData: leere/ungueltige Assembly crasht nicht", () => {
  assert.equal(buildGeometryData(null).indexCount, 0);
  assert.equal(buildGeometryData({ sizeX: 0, sizeY: 0, sizeZ: 0, palette: [], blocks: new Uint32Array(0) }).indexCount, 0);
});

// ---------------------------------------------------------------------------
// Farbzuordnung: alle 4 Vertices einer Flaeche teilen die Blockfarbe
// ---------------------------------------------------------------------------

test("buildGeometryData: Flaechen-Farbe entspricht colorForBlock (alle 4 Vertices gleich)", () => {
  const assembly = makeAssembly(1, 1, 1, [{ x: 0, y: 0, z: 0, id: "minecraft:stone" }]);
  const data = buildGeometryData(assembly);
  const [r, g, b] = parseCssColor(colorForBlock("minecraft:stone"));

  for (let v = 0; v < data.colors.length / 3; v++) {
    assert.ok(Math.abs(data.colors[v * 3] - r) < 1e-6, `vertex ${v} r`);
    assert.ok(Math.abs(data.colors[v * 3 + 1] - g) < 1e-6, `vertex ${v} g`);
    assert.ok(Math.abs(data.colors[v * 3 + 2] - b) < 1e-6, `vertex ${v} b`);
  }
});

test("buildGeometryData: unterschiedliche Bloecke bekommen unterschiedliche Vertex-Farben", () => {
  const assembly = makeAssembly(2, 1, 1, [
    { x: 0, y: 0, z: 0, id: "minecraft:stone" },
    { x: 1, y: 0, z: 0, id: "minecraft:oak_log" },
  ]);
  const data = buildGeometryData(assembly);
  const stoneRgb = parseCssColor(colorForBlock("minecraft:stone"));
  const logRgb = parseCssColor(colorForBlock("minecraft:oak_log"));
  assert.notDeepEqual(stoneRgb, logRgb);

  // Jeder Vertex-Farbwert muss zu genau einer der beiden Block-Farben passen.
  for (let v = 0; v < data.colors.length / 3; v++) {
    const c = [data.colors[v * 3], data.colors[v * 3 + 1], data.colors[v * 3 + 2]];
    const matchesStone = c.every((val, i) => Math.abs(val - stoneRgb[i]) < 1e-6);
    const matchesLog = c.every((val, i) => Math.abs(val - logRgb[i]) < 1e-6);
    assert.ok(matchesStone || matchesLog, `vertex ${v} color ${c} matches neither block`);
  }
});

// ---------------------------------------------------------------------------
// Normalen: pro Flaeche identisch, entsprechen einer der 6 Achsenrichtungen
// ---------------------------------------------------------------------------

test("buildGeometryData: jede Flaeche hat eine einheitliche Achsen-Normale ueber alle 4 Vertices", () => {
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

test("parseCssColor: Hex-Farben werden korrekt in [0,1]-RGB umgerechnet", () => {
  assert.deepEqual(parseCssColor("#ffffff"), [1, 1, 1]);
  assert.deepEqual(parseCssColor("#000000"), [0, 0, 0]);
  const [r, g, b] = parseCssColor("#8a8a8a");
  assert.ok(Math.abs(r - 0x8a / 255) < 1e-9);
  assert.ok(Math.abs(g - 0x8a / 255) < 1e-9);
  assert.ok(Math.abs(b - 0x8a / 255) < 1e-9);
});

test("parseCssColor: hsl(...)-Farben (Fallback aus colorForBlock) werden geparst", () => {
  const [r, g, b] = parseCssColor("hsl(0, 100%, 50%)"); // reines Rot
  assert.ok(Math.abs(r - 1) < 1e-6);
  assert.ok(Math.abs(g - 0) < 1e-6);
  assert.ok(Math.abs(b - 0) < 1e-6);
});

test("MAX_FOOTPRINT_CELLS ist wie im Brief spezifiziert (1_000_000)", () => {
  assert.equal(MAX_FOOTPRINT_CELLS, 1_000_000);
});
