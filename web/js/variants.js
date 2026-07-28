// Port von maze2schematic/tiles.py:_load_config (159-207) fuer die Web-Variante.
//
// Unterschied zum Python-Original: das "map"-Feld (Bias-Map je Cluster-Style)
// wird ignoriert (mit console.warn) -- Bias-Maps sind im Web-Port out of scope.

import { TileError } from "./tiles.js";

export function parseVariantsConfig(json) {
  const data = json ?? {};
  const keys = Object.keys(data);

  let rawWeights;
  let rawClusters;
  if (keys.every((k) => k === "weights" || k === "clusters")) {
    rawWeights = data.weights ?? {};
    rawClusters = data.clusters ?? {};
  } else {
    rawWeights = data;
    rawClusters = {};
  }

  const weights = {};
  for (const [stem, weight] of Object.entries(rawWeights)) {
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      throw new TileError(`variants.json: ungueltiges Gewicht fuer '${stem}': ${JSON.stringify(weight)}`);
    }
    weights[stem] = Number(weight);
  }

  const clusters = {};
  for (const [style, cfg] of Object.entries(rawClusters)) {
    const minSize = Number.isFinite(Number(cfg?.min)) ? Math.trunc(Number(cfg.min ?? 1)) : 1;
    const maxSize = Number.isFinite(Number(cfg?.max)) ? Math.trunc(Number(cfg.max ?? 1)) : 1;
    if (!(1 <= minSize && minSize <= maxSize)) {
      throw new TileError(`variants.json: ungueltige Cluster-Groessen fuer '${style}': ${JSON.stringify(cfg)}`);
    }
    if (cfg && cfg.map !== undefined && cfg.map !== null) {
      console.warn(
        `variants.json: Bias-Map fuer '${style}' wird ignoriert (Bias-Maps sind im Web-Port nicht unterstuetzt).`,
      );
    }
    clusters[style] = { minSize, maxSize };
  }

  return { weights, clusters };
}
