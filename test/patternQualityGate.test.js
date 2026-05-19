import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePatternQualityGate } from "../src/services/patternQualityGate.js";

function mkTrade({ win = true, i = 0, confidence = 0.62, rr = 1.3, ev = 0.2, spread = 0.18, cost = 0.08, imbalance = 0.2 }) {
  return {
    netPnlJpy: win ? 120 : -95,
    signalConfidence: confidence,
    signalMetrics: { rr, expectedValuePips: ev, spreadPips: spread, estimatedCostPips: cost, orderBookImbalance: imbalance },
    exitTime: new Date(2026, 0, 1, 0, i).toISOString()
  };
}

function mkDataset() {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push(mkTrade({ win: true, i, confidence: 0.62, rr: 1.32, ev: 0.24, imbalance: 0.22 }));
  for (let i = 40; i < 90; i += 1) rows.push(mkTrade({ win: false, i, confidence: 0.44, rr: 0.95, ev: -0.06, imbalance: -0.18 }));
  return rows;
}

test("pattern quality gate passes setup close to winner patterns", () => {
  const out = evaluatePatternQualityGate({
    signal: { confidence: 0.63, metrics: { rr: 1.3, expectedValuePips: 0.22, spreadPips: 0.18, estimatedCostPips: 0.08, orderBookImbalance: 0.2 } },
    trades: mkDataset(),
    cfg: { enabled: true, minTrades: 60, minScore: 0.5 }
  });
  assert.equal(out.allowed, true);
});

test("pattern quality gate blocks setup close to loser patterns", () => {
  const out = evaluatePatternQualityGate({
    signal: { confidence: 0.42, metrics: { rr: 0.9, expectedValuePips: -0.08, spreadPips: 0.24, estimatedCostPips: 0.1, orderBookImbalance: -0.2 } },
    trades: mkDataset(),
    cfg: { enabled: true, minTrades: 60, minScore: 0.5 }
  });
  assert.equal(out.allowed, false);
});

