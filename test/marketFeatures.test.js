import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketFeatureContext } from "../src/services/marketFeatures.js";

function makeCandle(i, base = 150) {
  const p = base + i * 0.01;
  return {
    open: p,
    high: p + 0.02,
    low: p - 0.02,
    close: p + 0.005,
    ts: new Date(Date.now() + i * 60000).toISOString()
  };
}

test("market features build trend and oscillator context", () => {
  const c1 = Array.from({ length: 120 }, (_, i) => makeCandle(i));
  const c5 = Array.from({ length: 80 }, (_, i) => makeCandle(i, 149.5));
  const c15 = Array.from({ length: 70 }, (_, i) => makeCandle(i, 149.2));
  const out = buildMarketFeatureContext({
    candles1m: c1,
    candles5m: c5,
    candles15m: c15,
    pipSize: 0.01,
    news: { shortTermRiskLevel: 0.2, score: 0.1 }
  });
  assert.equal(out.ready, true);
  assert.ok(Number.isFinite(out.rsi1m));
  assert.ok(Number.isFinite(out.macdHist1m));
  assert.ok(Number.isFinite(out.atrPips1m));
  assert.ok(["BUY", "SELL", "NEUTRAL"].includes(out.trendBias));
});
