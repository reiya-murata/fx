import test from "node:test";
import assert from "node:assert/strict";
import { evaluateContextValidation } from "../src/services/contextValidation.js";

function tradeWithKey(key) {
  return { banditContextKey: key };
}

test("context validation allows validated exact context", () => {
  const key = "reg:TREND_UP|spr:LOW|ev:MID|rr:MID|risk:LOW|sess:TOKYO|tag:GENERAL";
  const live = Array.from({ length: 22 }).map(() => tradeWithKey(key));
  const out = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "TREND_UP", news: { shortTermRiskLevel: 0.1 }, metrics: { spreadPips: 0.2 } },
    ticker: { spreadPips: 0.2 },
    liveTrades: live,
    shadowTrades: [],
    cfg: { enabled: true, minTradesPerContext: 20, minTradesPerCoarseContext: 40 }
  });
  assert.equal(out.allowed, true);
  assert.equal(out.mode, "LIVE");
});

test("context validation falls back to limited bootstrap for unknown safe context", () => {
  const key = "reg:RANGE|spr:LOW|ev:LOW|rr:MID|risk:LOW|sess:NY|tag:GENERAL";
  const out = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "RANGE", news: { shortTermRiskLevel: 0.1 }, metrics: { spreadPips: 0.2 } },
    ticker: { spreadPips: 0.2 },
    selectedRiskPercent: 5,
    liveTrades: [],
    shadowTrades: [],
    cfg: {
      enabled: true,
      minTradesPerContext: 20,
      allowBootstrapContexts: true,
      bootstrapSizeMultiplier: 0.5,
      bootstrapRiskReferencePercent: 5,
      bootstrapMinSizeMultiplier: 0.12,
      bootstrapRegimes: ["RANGE"],
      maxNewsRiskForBootstrap: 0.35,
      maxSpreadPipsForBootstrap: 0.28
    }
  });
  assert.equal(out.allowed, true);
  assert.equal(out.mode, "LIVE_LIMITED");
  assert.equal(out.sizeMultiplier, 0.5);
});

test("context bootstrap size multiplier scales with selected risk percent", () => {
  const key = "reg:RANGE|spr:LOW|ev:LOW|rr:MID|risk:LOW|sess:NY|tag:GENERAL";
  const lowRisk = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "RANGE", news: { shortTermRiskLevel: 0.1 }, metrics: { spreadPips: 0.2 } },
    ticker: { spreadPips: 0.2 },
    selectedRiskPercent: 2,
    liveTrades: [],
    shadowTrades: [],
    cfg: {
      enabled: true,
      allowBootstrapContexts: true,
      bootstrapSizeMultiplier: 0.5,
      bootstrapRiskReferencePercent: 5,
      bootstrapMinSizeMultiplier: 0.12,
      bootstrapCapByRiskPercent: [
        { maxRiskPercent: 2, cap: 0.25 },
        { maxRiskPercent: 5, cap: 0.5 },
        { maxRiskPercent: 10, cap: 0.65 }
      ],
      bootstrapRegimes: ["RANGE"]
    }
  });
  const highRisk = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "RANGE", news: { shortTermRiskLevel: 0.1 }, metrics: { spreadPips: 0.2 } },
    ticker: { spreadPips: 0.2 },
    selectedRiskPercent: 10,
    liveTrades: [],
    shadowTrades: [],
    cfg: {
      enabled: true,
      allowBootstrapContexts: true,
      bootstrapSizeMultiplier: 0.5,
      bootstrapRiskReferencePercent: 5,
      bootstrapMinSizeMultiplier: 0.12,
      bootstrapCapByRiskPercent: [
        { maxRiskPercent: 2, cap: 0.25 },
        { maxRiskPercent: 5, cap: 0.5 },
        { maxRiskPercent: 10, cap: 0.65 }
      ],
      bootstrapRegimes: ["RANGE"]
    }
  });
  assert.ok(lowRisk.sizeMultiplier < highRisk.sizeMultiplier);
  assert.equal(lowRisk.sizeMultiplier, 0.12);
  assert.equal(highRisk.sizeMultiplier, 0.65);
});

test("context validation blocks unknown high-risk context", () => {
  const key = "reg:HIGH_VOLATILITY|spr:HIGH|ev:LOW|rr:LOW|risk:HIGH|sess:NY|tag:GEOPOLITICAL";
  const out = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "HIGH_VOLATILITY", news: { shortTermRiskLevel: 0.8 }, metrics: { spreadPips: 0.45 } },
    ticker: { spreadPips: 0.45 },
    liveTrades: [],
    shadowTrades: [],
    cfg: {
      enabled: true,
      allowBootstrapContexts: true,
      bootstrapRegimes: ["TREND_UP", "TREND_DOWN", "RANGE"],
      maxNewsRiskForBootstrap: 0.35,
      maxSpreadPipsForBootstrap: 0.28
    }
  });
  assert.equal(out.allowed, false);
  assert.equal(out.mode, "VALIDATION_ONLY");
});

test("context validation can use bootstrap context counts", () => {
  const key = "reg:TREND_UP|spr:LOW|ev:MID|rr:MID|risk:LOW|sess:TOKYO|tag:GENERAL|hir:LOW|act:LOW|surp:LOW";
  const out = evaluateContextValidation({
    contextKey: key,
    signal: { regime: "TREND_UP", news: { shortTermRiskLevel: 0.1 }, metrics: { spreadPips: 0.18 } },
    ticker: { spreadPips: 0.18 },
    selectedRiskPercent: 5,
    liveTrades: [],
    shadowTrades: [],
    bootstrapContextCounts: { [key]: 30 },
    cfg: {
      enabled: true,
      minTradesPerContext: 20,
      minTradesPerCoarseContext: 40
    }
  });
  assert.equal(out.allowed, true);
  assert.equal(out.mode, "LIVE");
});
