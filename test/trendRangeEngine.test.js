import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrendEngine } from "../src/engine/trendEngine.js";
import { evaluateRangeEngine } from "../src/engine/rangeEngine.js";

const config = {
  pipSize: 0.01,
  exit: { stopAtrMultiplier: 1.2, tpAtrMultiplier: 1.8 },
  range: { maxRangePips: 18, earlyReversalEnabled: true, earlyReversalEdgeFactor: 0.16, earlyReversalMaxSpreadPips: 0.26 }
};

test("trend engine returns BUY in TREND_UP with non-negative momentum", () => {
  const out = evaluateTrendEngine({
    regime: "TREND_UP",
    ask: 150.12,
    bid: 150.1,
    atrValue: 0.05,
    marketFeatures: { momentumScore: 0.2 },
    config,
    regimeProfile: { stopAtrMultiplier: 1.1, tpAtrMultiplier: 2.0 }
  });
  assert.equal(out.action, "BUY");
  assert.ok(out.levels.entryPrice > 0);
});

test("range engine returns HOLD when edge is not confirmed", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    open: 150 + (i % 2 ? 0.01 : -0.01),
    high: 150.08,
    low: 149.92,
    close: 150
  }));
  const out = evaluateRangeEngine({
    regime: "RANGE",
    candles1m: candles,
    ask: 150.01,
    bid: 149.99,
    atrValue: 0.05,
    config,
    regimeProfile: { stopAtrMultiplier: 1.0, tpAtrMultiplier: 1.3 }
  });
  assert.equal(out.action, "HOLD");
});

test("range engine can take early reversal when spread is acceptable", () => {
  const candles = Array.from({ length: 20 }, (_, i) => {
    const base = 150 + (i * 0.001);
    return {
      open: base,
      high: 150.08,
      low: 149.92,
      close: i === 19 ? 149.935 : (i === 18 ? 149.93 : 149.94)
    };
  });
  const out = evaluateRangeEngine({
    regime: "RANGE",
    candles1m: candles,
    ask: 149.94,
    bid: 149.92,
    atrValue: 0.05,
    spreadPips: 0.2,
    marketFeatures: { momentumScore: 0.01 },
    config,
    regimeProfile: { stopAtrMultiplier: 1.0, tpAtrMultiplier: 1.3 }
  });
  assert.equal(out.action, "BUY");
});

test("range engine can produce BUY on range momentum breakout without edge reversal", () => {
  const closes = [
    150.00, 150.01, 150.00, 150.015, 150.01,
    150.02, 150.018, 150.025, 150.022, 150.03,
    150.028, 150.035, 150.04, 150.048, 150.055,
    150.062, 150.07, 150.078, 150.086, 150.095
  ];
  const candles = closes.map((close, i) => ({
    open: i === 0 ? close : closes[i - 1],
    high: close + 0.006,
    low: close - 0.006,
    close
  }));
  const out = evaluateRangeEngine({
    regime: "RANGE",
    candles1m: candles,
    ask: 150.105,
    bid: 150.095,
    atrValue: 0.03,
    spreadPips: 0.2,
    marketFeatures: { momentumScore: 0.14, rsi1m: 61 },
    config,
    regimeProfile: { stopAtrMultiplier: 1.0, tpAtrMultiplier: 1.5 }
  });
  assert.equal(out.action, "BUY");
  assert.match(out.rationale, /Range momentum breakout candidate \(BUY\)/);
});

test("range engine reports momentum breakout evaluation when HOLD", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    open: 150 + (i % 2 ? 0.01 : -0.01),
    high: 150.08,
    low: 149.92,
    close: 150
  }));
  const out = evaluateRangeEngine({
    regime: "RANGE",
    candles1m: candles,
    ask: 150.01,
    bid: 149.99,
    atrValue: 0.05,
    spreadPips: 0.2,
    marketFeatures: { momentumScore: 0, rsi1m: 50 },
    config,
    regimeProfile: { stopAtrMultiplier: 1.0, tpAtrMultiplier: 1.3 }
  });
  assert.equal(out.action, "HOLD");
  assert.match(out.rationale, /レンジブレイクアウト未確定/);
  assert.equal(out.diagnostics.rangeMomentumBreakout.evaluated, true);
});
