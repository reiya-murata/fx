import test from "node:test";
import assert from "node:assert/strict";
import { updateLearningMemoryFromTrades } from "../src/services/learningMemory.js";

function makeTrades(count, pnlFn) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }).map((_, i) => ({
    exitTime: new Date(base + i * 60_000).toISOString(),
    netPnlJpy: pnlFn(i),
    banditContextKey: `reg:RANGE|spr:LOW|ev:LOW|rr:MID|risk:LOW|sess:TOKYO|tag:GENERAL|id:${i % 3}`
  }));
}

test("learning memory updates ewma stats and contexts", () => {
  const trades = makeTrades(40, (i) => (i % 3 === 0 ? 1200 : -700));
  const out = updateLearningMemoryFromTrades(trades, { alpha: 0.05, maxContexts: 100 });
  assert.ok(out.totalTrades >= 40);
  assert.ok(Number.isFinite(out.ewmaExpectancyJpy));
  assert.ok(Object.keys(out.contextCounts || {}).length >= 1);
});
