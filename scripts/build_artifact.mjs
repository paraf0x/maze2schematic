// Builds a single self-contained HTML file from web/ for a Claude artifact:
// all ES modules concatenated (imports/exports stripped), three.js +
// OrbitControls wrapped as IIFEs, the built-in theme tiles embedded as
// base64, and fetch() replaced by __presetFetch().
//
// Usage: node scripts/build_artifact.mjs [outDir]
//   outDir defaults to /tmp. Writes <outDir>/maze2schematic.html,
//   <outDir>/bundle.js, and <outDir>/bundle-smoke.mjs (a Node-runnable
//   smoke test of the bundle's full pipeline).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "web");
const OUT_DIR = process.argv[2] || "/tmp";
mkdirSync(OUT_DIR, { recursive: true });
const R = (p) => readFileSync(path.join(ROOT, p), "utf8");

function stripModule(src) {
  // Alias imports (`import { setActive as set3dActive } from ...`) must
  // survive stripping as const bindings -- the original names are already
  // defined by concatenation order.
  const aliases = [];
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?/gm)) {
    for (const entry of m[1].split(",")) {
      const am = entry.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (am) aliases.push(`const ${am[2]} = ${am[1]};`);
    }
  }
  src = src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?[^\S\n]*$/gm, "");
  src = src.replace(/^import\s+["'][^"']+["'];?[^\S\n]*$/gm, "");
  src = src.replace(/^export\s+\{[^}]*\};?[^\S\n]*$/gm, "");
  src = src.replace(/^export\s+/gm, "");
  return (aliases.length ? aliases.join("\n") + "\n" : "") + src;
}

// --- Our own modules, in dependency order --------------------------------
// "themes" (serializeTheme/deserializeTheme) is pure/dependency-free and
// only needed by main.js's theme save/delete flow; any position before
// main.js works.
const ORDER = ["rng", "generate", "classify", "nbt", "litematic", "tiles",
  "variants", "assemble", "themes", "preview2d"];
const parts = [];
for (const name of ORDER) {
  parts.push(`// ===== web/js/${name}.js =====`);
  parts.push(stripModule(R(`js/${name}.js`)));
}

// --- Robust export layer (replaces web/js/export.js in the artifact) -----
// 1. gzip: CompressionStream, else a pure-JS fallback (gzip with "stored"
//    deflate blocks -- uncompressed, but format-valid).
// 2. gunzip: detects from the magic byte whether the input is gzip at all
//    (the embedded theme tiles are stored uncompressed).
// 3. downloadBlob: share sheet on touch devices (navigator.share), else an
//    anchor download with a delayed revokeObjectURL (revoking immediately
//    aborts the download in Safari/Firefox).
parts.push(`// ===== robust export layer (artifact variant) =====
const supportsCompression = () => true;
async function __pipe(u8, stream) {
  const out = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
function __crc32(b) {
  let crc = ~0;
  for (let i = 0; i < b.length; i++) {
    crc ^= b[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function __gzipStore(data) {
  const chunks = [Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])];
  let pos = 0;
  do {
    const chunk = data.subarray(pos, pos + 65535);
    pos += chunk.length;
    const final = pos >= data.length ? 1 : 0;
    const len = chunk.length;
    chunks.push(Uint8Array.from([final, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255]));
    chunks.push(chunk);
  } while (pos < data.length);
  const crc = __crc32(data);
  const size = data.length >>> 0;
  chunks.push(Uint8Array.from([
    crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, (crc >>> 24) & 255,
    size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255,
  ]));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
const gzip = async (u8) =>
  typeof CompressionStream !== "undefined" ? __pipe(u8, new CompressionStream("gzip")) : __gzipStore(u8);
const gunzip = async (u8) => {
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser cannot decompress gzip (DecompressionStream is missing)");
  }
  return __pipe(u8, new DecompressionStream("gzip"));
};
async function downloadBlob(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  if (coarse && typeof File !== "undefined" && navigator.canShare) {
    const file = new File([blob], filename, { type: "application/octet-stream" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled
        // otherwise fall through to the anchor download
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}`);

// --- three.js as an IIFE ---------------------------------------------------
let three = R("vendor/three.module.js");
const threeExport = three.match(/^export\s*\{([\s\S]*?)\};\s*$/m);
if (!threeExport) throw new Error("three.module.js: export block not found");
three = three.replace(threeExport[0], `return {${threeExport[1]}};`);
parts.push("// ===== vendor/three.module.js (IIFE) =====");
parts.push(`const THREE = (() => {\n${three}\n})();`);

// --- OrbitControls as an IIFE ----------------------------------------------
let oc = readFileSync(path.join(ROOT, "vendor/OrbitControls.js"), "utf8");
const ocImport = oc.match(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];/m);
if (!ocImport) throw new Error("OrbitControls.js: import block not found");
const ocNames = ocImport[1].split(",").map((s) => s.trim()).filter(Boolean);
oc = oc.replace(ocImport[0], "");
if (!/^export\s*\{\s*OrbitControls\s*\};?/m.test(oc)) throw new Error("OrbitControls: export not found");
oc = oc.replace(/^export\s*\{\s*OrbitControls\s*\};?[^\S\n]*$/m, "return { OrbitControls };");
parts.push("// ===== vendor/OrbitControls.js (IIFE) =====");
parts.push(`const { OrbitControls } = (() => {\nconst { ${ocNames.join(", ")} } = THREE;\n${oc}\n})();`);

parts.push("// ===== web/js/preview3d.js =====");
parts.push(stripModule(R("js/preview3d.js")));

// --- Embed the built-in themes ---------------------------------------------
const manifestText = R("themes/index.json");
const manifest = JSON.parse(manifestText);
const presetText = { "themes/index.json": manifestText };
const presetBin = {};
for (const theme of manifest.themes) {
  if (theme.variants) {
    presetText[`themes/${theme.dir}/${theme.variants}`] = R(`themes/${theme.dir}/${theme.variants}`);
  }
  for (const rel of theme.files) {
    // Embedded uncompressed: keeps the load path independent of
    // DecompressionStream (missing in some mobile WebViews); gunzip()
    // passes these through unchanged (see the export layer above).
    presetBin[`themes/${theme.dir}/${rel}`] =
      gunzipSync(readFileSync(path.join(ROOT, `themes/${theme.dir}/${rel}`))).toString("base64");
  }
}
parts.push("// ===== embedded themes + fetch replacement =====");
parts.push(`const __PRESET_TEXT = ${JSON.stringify(presetText)};
const __PRESET_BIN = ${JSON.stringify(presetBin)};
async function __presetFetch(path) {
  if (path in __PRESET_TEXT) {
    return { ok: true, status: 200, json: async () => JSON.parse(__PRESET_TEXT[path]) };
  }
  if (path in __PRESET_BIN) {
    const bin = atob(__PRESET_BIN[path]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
  }
  return { ok: false, status: 404 };
}`);

// --- Global error display (diagnosis on a phone without a console) --------
parts.push(`// ===== global error display =====
function __reportError(msg) {
  const ul = document.getElementById("messages");
  if (!ul) return;
  const li = document.createElement("li");
  li.className = "msg msg-error";
  li.textContent = msg;
  ul.prepend(li);
}
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => __reportError("Error: " + (e.message || e.type)));
  window.addEventListener("unhandledrejection", (e) => __reportError("Error (async): " + ((e.reason && e.reason.message) || e.reason)));
}`);

// --- main.js: fetch -> __presetFetch ---------------------------------------
let main = stripModule(R("js/main.js"));
const fetchCount = (main.match(/await fetch\(/g) || []).length;
if (fetchCount < 1) throw new Error(`main.js: expected at least 1 "await fetch(" call, found ${fetchCount}`);
main = main.replace(/await fetch\(/g, "await __presetFetch(");
parts.push("// ===== web/js/main.js =====");
parts.push(main);

const bundle = parts.join("\n");

// --- Assemble the HTML ------------------------------------------------------
const css = R("css/style.css");
const html = R("index.html");
const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error("index.html: <body> not found");
let body = bodyMatch[1].replace(/<script[^>]*src="js\/main\.js"[^>]*><\/script>\s*/, "");

const out = `<title>maze2schematic</title>
<style>
${css}
</style>
${body}
<script type="module">
${bundle}
</script>
`;

writeFileSync(path.join(OUT_DIR, "maze2schematic.html"), out);
writeFileSync(path.join(OUT_DIR, "bundle.js"), bundle);

// Smoke variant for Node: runs the pipeline once end to end, loading the
// "classic" theme through __presetFetch exactly like the browser would.
const smoke = bundle + `
;(async () => {
  const mf = await __presetFetch("themes/index.json");
  const manifest = await mf.json();
  const meta = manifest.themes.find((t) => t.id === "classic");
  if (!meta) throw new Error("classic theme missing from embedded manifest");
  const entries = await Promise.all(meta.files.map(async (rel) => {
    const r = await __presetFetch("themes/" + meta.dir + "/" + rel);
    const raw = new Uint8Array(await r.arrayBuffer());
    return { filename: rel.split("/").pop(), doc: parseLitematic(await gunzip(raw)) };
  }));
  const cfg = parseVariantsConfig(await (await __presetFetch("themes/" + meta.dir + "/" + meta.variants)).json());
  const ts = TileSet.fromEntries(entries, cfg);
  const maze = generateMaze(defaultOptions(), makeRng(42));
  const a = assembleBlocks(maze, ts, makeRng(42));
  const bytes = writeLitematic({ ...a, name: "maze", author: "smoke", timestamp: 0 });
  // Verify the store-gzip fallback against node:zlib.
  const { gunzipSync } = await import("node:zlib");
  const stored = __gzipStore(bytes);
  const back = gunzipSync(stored);
  if (Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) throw new Error("gzipStore roundtrip broken");
  const empty = gunzipSync(__gzipStore(new Uint8Array(0)));
  if (empty.length !== 0) throw new Error("gzipStore empty-input case broken");

  // Also exercise the theme (de)serialization roundtrip used by "Save as theme...".
  const themeJson = serializeTheme({
    id: "smoke", label: "Smoke", tiles: entries.map((e) => ({ filename: e.filename, bytes })),
    weights: { straight: 3 }, disabled: [], clusters: {},
  });
  const themeBack = deserializeTheme(JSON.parse(JSON.stringify(themeJson)));
  if (Buffer.compare(Buffer.from(themeBack.tiles[0].bytes), Buffer.from(bytes)) !== 0) {
    throw new Error("theme serialize/deserialize roundtrip broken");
  }

  console.log("SMOKE OK", a.sizeX + "x" + a.sizeY + "x" + a.sizeZ, "palette=" + a.palette.length,
    "nbt=" + bytes.length + "B", "gzipStore=" + stored.length + "B roundtrip ok", "themes=" + manifest.themes.length);
})();
`;
writeFileSync(path.join(OUT_DIR, "bundle-smoke.mjs"), smoke);
console.log("written:", path.join(OUT_DIR, "maze2schematic.html"), `(${Math.round(out.length / 1024)} KiB)`);
