import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDegradationGuard } from "../src/services/degradationGuard.js";

function mkTrades(losses = 0, total = 24) {
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const isLoss = i >= (total - losses);
    out.push({
      netPnlJpy: isLoss ? -350 : 140,
      exitTime: new Date(2026, 0, 1, 0, i).toISOString()
    });
  }
  return out;
}

test("degradation guard enters DEGRADED mode on weak recent performance", () => {
  const out = evaluateDegradationGuard({
    trades: mkTrades(14, 24),
    memory: null,
    cfg: { enabled: true, minTrades: 20, warningExpectancyJpy: -50, warningWinRate: 0.45 }
  });
  assert.equal(out.mode === "DEGRADED" || out.mode === "SEVERE", true);
  assert.ok(out.riskMultiplier < 1);
});

test("degradation guard stays NORMAL when recent performance is healthy", () => {
  const out = evaluateDegradationGuard({
    trades: mkTrades(2, 24),
    memory: null,
    cfg: { enabled: true, minTrades: 20, warningExpectancyJpy: -200, warningWinRate: 0.35 }
  });
  assert.equal(out.mode, "NORMAL");
  assert.equal(out.riskMultiplier, 1);
});
