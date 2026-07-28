import { test } from "node:test";
import assert from "node:assert/strict";
import { N, E, S, W } from "../js/generate.js";
import { classify } from "../js/classify.js";

// Erwartungswerte aus classify.py abgeleitet: kanonisch + kleinste Rotation.
const CASES = [
  [[], "closed", 0],
  [[N], "dead_end", 0], [[E], "dead_end", 1], [[S], "dead_end", 2], [[W], "dead_end", 3],
  [[N, S], "straight", 0], [[E, W], "straight", 1],
  [[N, E], "turn", 0], [[E, S], "turn", 1], [[S, W], "turn", 2], [[N, W], "turn", 3],
  [[E, S, W], "tee", 0], [[N, S, W], "tee", 1], [[N, E, W], "tee", 2], [[N, E, S], "tee", 3],
  [[N, E, S, W], "cross", 0],
];

test("alle 16 Masken werden korrekt klassifiziert", () => {
  for (const [dirs, name, rotation] of CASES) {
    assert.deepEqual(classify(new Set(dirs)), { name, rotation }, `Maske {${dirs}}`);
  }
});
