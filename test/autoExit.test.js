import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStopRequestExit, planAutoHold, shouldRiskCutPosition } from "../src/engine/autoExit.js";

const baseSignal = {
  confidence: 0.6,
  entryPrice: 150,
  stopLossPrice: 149.97,
  metrics: {
    expectedValuePips: 0.25,
    rr: 1.4,
    spreadPips: 0.2
  }
};

test("planAutoHold extends duration when expectancy is high", () => {
  const out = planAutoHold({
    baseSec: 180,
    maxHoldSec: 300,
    pipSize: 0.01,
    signal: {
      ...baseSignal,
      confidence: 0.82,
      metrics: { expectedValuePips: 0.95, rr: 2.0, spreadPips: 0.15 }
    },
    ticker: { spreadPips: 0.15 }
  });

  assert.ok(out.holdSec > 180);
  assert.ok(out.qualityScore > 0);
});

test("planAutoHold shortens duration under high risk", () => {
  const out = planAutoHold({
    baseSec: 180,
    maxHoldSec: 300,
    pipSize: 0.01,
    signal: {
      ...baseSignal,
      confidence: 0.34,
      stopLossPrice: 149.94,
      metrics: { expectedValuePips: 0.02, rr: 1.0, spreadPips: 0.55 }
    },
    ticker: { spreadPips: 0.55 }
  });

  assert.ok(out.holdSec < 180);
  assert.ok(out.riskScore >= 0.65);
});

test("shouldRiskCutPosition triggers for high-risk losing trade", () => {
  const now = Date.now();
  const shouldCut = shouldRiskCutPosition({
    side: "LONG",
    entryPrice: 150,
    openedAt: new Date(now - 12000).toISOString(),
    riskScore: 0.9,
    riskCutPips: 0.8
  }, 149.991, now, 0.01);

  assert.equal(shouldCut, true);
});

test("evaluateStopRequestExit closes at peak retrace in realtime mode", () => {
  const now = Date.now();
  const out = evaluateStopRequestExit({
    side: "LONG",
    entryPrice: 150,
    openedAt: new Date(now - 20000).toISOString(),
    plannedHoldSec: 120,
    maxHoldSec: 300,
    riskCutPips: 0.8,
    riskScore: 0.7,
    qualityScore: 0.2,
    peakPnlPips: 2.2,
    peakAt: new Date(now - 5000).toISOString()
  }, 150.013, now, 0.01, { stopRequested: false }); // pnl 1.3 pips, retrace 0.9 pips

  assert.equal(out.shouldClose, true);
  assert.equal(out.reason, "auto-peak-take");
});
