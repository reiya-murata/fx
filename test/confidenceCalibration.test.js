import test from "node:test";
import assert from "node:assert/strict";
import { buildConfidenceCalibration, calibrateConfidence } from "../src/services/confidenceCalibration.js";

function mkTrades(n = 80) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = (i % 10) / 10;
    out.push({
      signalConfidence: c,
      netPnlJpy: c >= 0.6 ? 120 : -90,
      exitTime: new Date(2026, 0, 1, 0, i).toISOString()
    });
  }
  return out;
}

test("confidence calibration builds model with enough trades", () => {
  const model = buildConfidenceCalibration({
    trades: mkTrades(),
    cfg: { enabled: true, minTrades: 30, bins: 5, shrinkage: 10 }
  });
  assert.equal(model.ready, true);
  assert.equal(model.bins, 5);
  assert.ok(model.sampleSize >= 30);
});

test("calibrateConfidence boosts high-confidence bins with better realized win-rate", () => {
  const model = buildConfidenceCalibration({
    trades: mkTrades(),
    cfg: { enabled: true, minTrades: 30, bins: 5, shrinkage: 8 }
  });
  const out = calibrateConfidence(0.8, model);
  assert.ok(out >= 0.8);
});

