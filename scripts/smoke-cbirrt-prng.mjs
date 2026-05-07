// Smoke test for the deterministic PRNG used by CBiRRT.
// Re-implements mulberry32 inline to avoid the .ts CDN-import chain.
function createMulberry32(seed = 1) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const a = createMulberry32(42);
const b = createMulberry32(42);
const c = createMulberry32(43);
const seqA = Array.from({ length: 5 }, () => a());
const seqB = Array.from({ length: 5 }, () => b());
const seqC = Array.from({ length: 5 }, () => c());
const allInRange = seqA.every((v) => v >= 0 && v < 1);
const matches = seqA.every((v, i) => v === seqB[i]);
const differs = seqA.some((v, i) => v !== seqC[i]);
console.log({ seqA, seqB, seqC, allInRange, matches, differs });
if (!allInRange) {
  console.error("FAIL: sample out of [0,1) range");
  process.exit(1);
}
if (!matches) {
  console.error("FAIL: same seed should give same sequence");
  process.exit(1);
}
if (!differs) {
  console.error("FAIL: different seed should give different sequence");
  process.exit(1);
}
console.log("PASS");
