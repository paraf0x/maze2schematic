import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../js/rng.js";

test("same seed yields same sequence", () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.random(), b.random());
});

test("random() is within [0,1)", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r.random();
    assert.ok(v >= 0 && v < 1);
  }
});

test("randRange/randIntRange/choice respect bounds", () => {
  const r = makeRng(1);
  for (let i = 0; i < 1000; i++) {
    assert.ok(r.randRange(5) >= 0 && r.randRange(5) < 5);
    const v = r.randIntRange(2, 4);
    assert.ok(v >= 2 && v <= 4);
  }
  assert.ok([1, 2, 3].includes(r.choice([1, 2, 3])));
});

test("shuffle permutes in place", () => {
  const r = makeRng(3);
  const arr = [1, 2, 3, 4, 5];
  r.shuffle(arr);
  assert.deepEqual([...arr].sort(), [1, 2, 3, 4, 5]);
});

test("weightedIndex respects zero weights", () => {
  const r = makeRng(9);
  for (let i = 0; i < 200; i++) {
    assert.equal(r.weightedIndex([0, 1, 0]), 1);
  }
});
