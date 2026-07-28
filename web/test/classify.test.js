import { test } from "node:test";
import assert from "node:assert/strict";
import { N, E, S, W } from "../js/generate.js";
import { classify, arrowSpecs } from "../js/classify.js";

// Expected values derived from classify.py: canonical + smallest rotation.
const CASES = [
  [[], "closed", 0],
  [[N], "dead_end", 0], [[E], "dead_end", 1], [[S], "dead_end", 2], [[W], "dead_end", 3],
  [[N, S], "straight", 0], [[E, W], "straight", 1],
  [[N, E], "turn", 0], [[E, S], "turn", 1], [[S, W], "turn", 2], [[N, W], "turn", 3],
  [[E, S, W], "tee", 0], [[N, S, W], "tee", 1], [[N, E, W], "tee", 2], [[N, E, S], "tee", 3],
  [[N, E, S, W], "cross", 0],
];

test("all 16 masks are classified correctly", () => {
  for (const [dirs, name, rotation] of CASES) {
    assert.deepEqual(classify(new Set(dirs)), { name, rotation }, `mask {${dirs}}`);
  }
});

// ---------------------------------------------------------------------------
// arrowSpecs
// ---------------------------------------------------------------------------

test("arrowSpecs: closed has no arrows", () => {
  assert.deepEqual(arrowSpecs("closed"), []);
});

test("arrowSpecs: unknown type name has no arrows", () => {
  assert.deepEqual(arrowSpecs("not_a_real_type"), []);
  assert.deepEqual(arrowSpecs(undefined), []);
});

test("arrowSpecs: dead_end -- single opening is the entrance", () => {
  assert.deepEqual(arrowSpecs("dead_end"), [{ dir: N, kind: "in" }]);
});

test("arrowSpecs: straight -- first canonical direction is the entrance, the rest are exits", () => {
  assert.deepEqual(arrowSpecs("straight"), [
    { dir: N, kind: "in" },
    { dir: S, kind: "out" },
  ]);
});

test("arrowSpecs: turn", () => {
  assert.deepEqual(arrowSpecs("turn"), [
    { dir: N, kind: "in" },
    { dir: E, kind: "out" },
  ]);
});

test("arrowSpecs: tee", () => {
  assert.deepEqual(arrowSpecs("tee"), [
    { dir: E, kind: "in" },
    { dir: S, kind: "out" },
    { dir: W, kind: "out" },
  ]);
});

test("arrowSpecs: cross -- exactly one entrance, the rest exits", () => {
  const specs = arrowSpecs("cross");
  assert.deepEqual(specs, [
    { dir: N, kind: "in" },
    { dir: E, kind: "out" },
    { dir: S, kind: "out" },
    { dir: W, kind: "out" },
  ]);
  assert.equal(specs.filter((s) => s.kind === "in").length, 1);
});
