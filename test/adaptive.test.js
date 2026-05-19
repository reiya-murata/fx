import test from "node:test";
import assert from "node:assert/strict";
import { computeAdaptiveTuning } from "../src/services/adaptive.js";

const goodTrades = Array.from({ length: 30 }).map((_, i) => ({
  exitTime: new Date(Date.UTC(2026, 1, 1, 0, i, 0)).toISOString(),
  netPnlJpy: i % 4 === 0 ? -200 : 500
}));

const badTrades = Array.from({ length: 30 }).map((_, i) => ({
  exitTime: new Date(Date.UTC(2026, 1, 2, 0, i, 0)).toISOString(),
  netPnlJpy: i % 4 === 0 ? 100 : -450
}));

test("adaptive tuning relaxes on good expectancy", () => {
  const out = computeAdaptiveTuning(goodTrades);
  assert.ok(out.expectancyJpy > 0);
  assert.ok(out.riskMultiplier >= 1);
});

test("adaptive tuning tightens on bad expectancy", () => {
  const out = computeAdaptiveTuning(badTrades);
  assert.ok(out.expectancyJpy < 0);
  assert.ok(out.riskMultiplier < 1);
  assert.ok(out.minRiskRewardDelta > 0);
});
