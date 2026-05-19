import test from "node:test";
import assert from "node:assert/strict";
import { Regime, smoothRegime } from "../src/engine/regime.js";

test("regime smoothing keeps stable regime when history agrees", () => {
  const trades = Array.from({ length: 30 }).map((_, i) => ({
    exitTime: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString(),
    regime: Regime.RANGE
  }));
  const out = smoothRegime(Regime.TREND_UP, trades, { regimeSmoothing: { enabled: true, lookbackTrades: 30, stayBias: 0.7 } });
  assert.equal(out, Regime.RANGE);
});
