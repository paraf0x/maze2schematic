// Pure (DOM-free) serialization helpers for user themes, so a theme can be
// saved to/restored from localStorage. A "theme" here is the plain data a
// user theme needs to be reconstructed: the tile files (as their
// uncompressed NBT bytes -- see litematic.js), per-tile weights/disabled
// flags, and the cluster config. No parsing/DOM/litematic.js dependency on
// purpose, so this module is trivially Node-testable and has no import-time
// side effects.
//
// `serializeTheme`/`deserializeTheme` are inverses: serializeTheme produces
// the JSON-safe shape written to localStorage (tile bytes as base64
// strings); deserializeTheme reads that shape back into
// `{id, label, tiles: [{filename, bytes: Uint8Array}], weights, disabled,
// clusters}`. main.js is responsible for turning `tiles[].bytes` into
// parsed docs (via `parseLitematic`) and building the tile pool -- kept out
// of this module so it stays DOM/NBT-free.

/** Uint8Array -> base64 string. Chunked to avoid blowing the call stack on
 * `String.fromCharCode(...bytes)` for large tiles. */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 string -> Uint8Array. Throws (from `atob`) on malformed input --
 * callers should wrap with a more specific error message (see
 * `deserializeTheme`). */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Builds the JSON-safe (localStorage-writable) shape for a theme.
 * `theme.tiles` is any iterable of `{filename, bytes: Uint8Array}`. */
export function serializeTheme(theme) {
  const { id, label, tiles, weights, disabled, clusters } = theme ?? {};
  return {
    id,
    label,
    tiles: [...(tiles ?? [])].map(({ filename, bytes }) => ({
      filename,
      data: bytesToBase64(bytes),
    })),
    weights: { ...(weights ?? {}) },
    disabled: [...(disabled ?? [])],
    clusters: clusters ?? {},
  };
}

/** Reverses `serializeTheme`. Throws a plain `Error` with a descriptive
 * message on any structural problem (missing id/label/tiles, non-string
 * fields, corrupted base64 tile data) -- callers (main.js, on startup) are
 * expected to catch this per-theme and skip the offending entry rather than
 * let a single corrupted theme break the whole app. */
export function deserializeTheme(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Invalid theme data.");
  }
  const { id, label, tiles, weights, disabled, clusters } = json;
  if (typeof id !== "string" || !id) {
    throw new Error("Theme is missing an id.");
  }
  if (typeof label !== "string" || !label) {
    throw new Error("Theme is missing a label.");
  }
  if (!Array.isArray(tiles)) {
    throw new Error(`Theme '${id}' is missing its tile list.`);
  }

  const parsedTiles = tiles.map((entry, i) => {
    const filename = entry?.filename;
    const data = entry?.data;
    if (typeof filename !== "string" || !filename) {
      throw new Error(`Theme '${id}': tile #${i} is missing a filename.`);
    }
    if (typeof data !== "string") {
      throw new Error(`Theme '${id}': tile '${filename}' is missing its data.`);
    }
    let bytes;
    try {
      bytes = base64ToBytes(data);
    } catch {
      throw new Error(`Theme '${id}': tile '${filename}' has corrupted data.`);
    }
    return { filename, bytes };
  });

  return {
    id,
    label,
    tiles: parsedTiles,
    weights: weights && typeof weights === "object" ? { ...weights } : {},
    disabled: Array.isArray(disabled) ? [...disabled] : [],
    clusters: clusters && typeof clusters === "object" ? clusters : {},
  };
}
