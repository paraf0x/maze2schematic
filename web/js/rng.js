// Seedable PRNG (mulberry32). Same seed => same sequence.
export function makeRng(seed) {
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const randInt = (x) => Math.floor(random() * x);
  const randRange = (n) => Math.floor(random() * n);
  const randIntRange = (a, b) => a + Math.floor(random() * (b - a + 1));
  const choice = (arr) => arr[randRange(arr.length)];
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  function weightedIndex(weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
  return { random, randInt, randRange, randIntRange, choice, shuffle, weightedIndex };
}
