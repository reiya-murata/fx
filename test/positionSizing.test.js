import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { applyBrokerProfile } from "../src/config/brokerProfiles.js";
import { calculateUsdJpyPositionSizing, optimizePositionSize } from "../src/services/positionSizing.js";

function makeTrades(count, pnlFn) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }).map((_, i) => ({
    exitTime: new Date(base + i * 60_000).toISOString(),
    netPnlJpy: pnlFn(i)
  }));
}

test("continuous sizing shrinks under poor expectancy", () => {
  const trades = makeTrades(40, (i) => (i % 5 === 0 ? 900 : -1200));
  const out = optimizePositionSize({
    signal: { metrics: { expectedValuePips: -0.2 } },
    trades,
    cfg: { enabled: true, minTrades: 20, lookbackTrades: 40 }
  });
  assert.ok(out.sizeMultiplier < 1);
});

test("continuous sizing expands on strong expectancy", () => {
  const trades = makeTrades(40, (i) => (i % 3 === 0 ? -700 : 1500));
  const out = optimizePositionSize({
    signal: { metrics: { expectedValuePips: 0.5 } },
    trades,
    cfg: { enabled: true, minTrades: 20, lookbackTrades: 40, maxSizeMultiplier: 1.3 }
  });
  assert.ok(out.sizeMultiplier > 1);
});

test("usd/jpy sizing uses yen risk and caps by effective leverage", () => {
  const out = calculateUsdJpyPositionSizing({
    settings: {
      balanceJPY: 100000,
      sizingMode: "fixedRiskJPY",
      riskAmountJPY: 1000,
      maxEffectiveLeverage: 5,
      minUnits: 1000,
      maxUnits: 50000
    },
    stopLossPips: 3,
    currentUsdJpyPrice: 150,
    leverage: 25
  });
  assert.equal(out.calculatedUnits, 3333);
  assert.equal(out.displayUnitsText, "3,333通貨");
  assert.equal(Math.round(out.estimatedExposureJPY), 499950);
  assert.equal(Math.round(out.requiredMarginJPY), 19998);
  assert.ok(out.cappedByLeverage);
  assert.equal(out.blockedReason, null);
});

test("usd/jpy sizing blocks risk above 3 percent of balance", () => {
  const out = calculateUsdJpyPositionSizing({
    settings: {
      balanceJPY: 100000,
      sizingMode: "fixedRiskJPY",
      riskAmountJPY: 4000,
      maxEffectiveLeverage: 5,
      minUnits: 1000,
      maxUnits: 50000
    },
    stopLossPips: 3,
    currentUsdJpyPrice: 150,
    leverage: 25
  });
  assert.equal(out.blockedReason, "riskAmountJPY_over_3_percent");
});

test("GMO_FX broker profile uses 1000-unit minimum and step", () => {
  const gmo = applyBrokerProfile(DEFAULT_CONFIG, "GMO_FX");
  const sbi = applyBrokerProfile(DEFAULT_CONFIG, "SBI_FX");
  assert.equal(gmo.brokerProfile.minUnits, 1000);
  assert.equal(gmo.positionSizing.brokerMinUnits, 1000);
  assert.equal(gmo.positionSizing.unitStep, 1000);
  assert.equal(sbi.brokerProfile.minUnits, 1);
  assert.equal(sbi.positionSizing.brokerMinUnits, 1);
  assert.equal(sbi.positionSizing.unitStep, 1);
});

test("GMO_FX sizing rounds down to 1000-unit steps", () => {
  const out = calculateUsdJpyPositionSizing({
    settings: {
      balanceJPY: 100000,
      sizingMode: "fixedRiskJPY",
      riskAmountJPY: 1000,
      maxEffectiveLeverage: 5,
      brokerMinUnits: 1000,
      minUnits: 1000,
      unitStep: 1000,
      maxUnits: 50000,
      hardBlockRiskPercentPerTrade: 15
    },
    stopLossPips: 3,
    currentUsdJpyPrice: 150,
    leverage: 25
  });
  assert.equal(out.brokerMinUnits, 1000);
  assert.equal(out.unitStep, 1000);
  assert.equal(out.calculatedUnits, 3000);
  assert.equal(out.calculatedUnits % 1000, 0);
  assert.equal(out.blockedReason, null);
});

test("GMO_FX sizing blocks when leverage cap leaves units below 1000", () => {
  const out = calculateUsdJpyPositionSizing({
    settings: {
      balanceJPY: 10000,
      sizingMode: "fixedRiskJPY",
      riskAmountJPY: 500,
      maxEffectiveLeverage: 5,
      brokerMinUnits: 1000,
      minUnits: 1000,
      unitStep: 1000,
      maxUnits: 50000,
      hardBlockRiskPercentPerTrade: 15
    },
    stopLossPips: 3,
    currentUsdJpyPrice: 150,
    leverage: 25
  });
  assert.equal(out.brokerMinUnits, 1000);
  assert.equal(out.unitStep, 1000);
  assert.equal(out.calculatedUnits, 0);
  assert.equal(out.minUnitsBlocked, true);
  assert.equal(out.blockedReason, "leverage_cap_makes_units_below_minUnits");
});
