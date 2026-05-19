import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCapitalScaling } from "../src/services/capitalScaling.js";

const cfg = {
  enabled: true,
  tiers: [
    { id: "UNDER_20K", label: "under", minBalanceJPY: 0, maxBalanceJPY: 19999, riskPercentPerTrade: 5, maxRiskPercentPerTrade: 8, maxEffectiveLeverage: 10, allowedModes: ["BASE"] },
    { id: "TIER_20K_50K", label: "mid", minBalanceJPY: 20000, maxBalanceJPY: 49999, riskPercentPerTrade: 4, maxRiskPercentPerTrade: 7, maxEffectiveLeverage: 15, allowedModes: ["BASE", "SEMI"] },
    { id: "TIER_50K_100K", label: "trial", minBalanceJPY: 50000, maxBalanceJPY: 99999, riskPercentPerTrade: 3, maxRiskPercentPerTrade: 6, maxEffectiveLeverage: 20, allowedModes: ["BASE", "SEMI"], fullTrialEnabled: true, fullTrialRiskMultiplier: 0.5, fullTrialMaxTradesPerDay: 2 }
  ],
  promotionRules: {
    requireBalanceAboveTierForTrades: 30,
    requireRollingPFMin: 1.1,
    requireRollingExpectancyPositive: true,
    requireNoDrawdownWarning: true,
    requireNoExecutionStress: true,
    requireNoConsecutiveLossWarning: true
  },
  demotionRules: {
    demoteImmediatelyIfBalanceFallsBelowTier: true,
    demoteOnDrawdownWarning: true,
    demoteOnDailyLossWarning: true,
    demoteOnConsecutiveLosses: 2,
    demoteOnExecutionStress: true,
    demoteOnRollingExpectancyNegative: true
  },
  fullUnlockRules: {
    normalFullMinBalanceJPY: 100000,
    trialFullMinBalanceJPY: 50000,
    trialFullRiskMultiplier: 0.5,
    trialFullMaxTradesPerDay: 2,
    rollingPFMin: 1.2,
    requireRollingExpectancyPositive: true
  }
};

function trades(n) {
  return Array.from({ length: n }).map((_, i) => ({
    exitReason: "auto-tp",
    entryTime: new Date(Date.now() - (n - i) * 60_000).toISOString(),
    netPnlJpy: 100
  }));
}

test("capital scaling keeps active tier until promotion confirmation passes", () => {
  const out = evaluateCapitalScaling({
    state: {
      capitalScalingRuntime: { activeTierId: "UNDER_20K", candidateTierId: "UNDER_20K", candidateTierReachedAt: new Date().toISOString() },
      trades: trades(10),
      account: { consecutiveLosses: 0 }
    },
    currentBalanceJPY: 21000,
    cfg,
    rolling: { sampleSize: 30, profitFactor: 1.2, expectancyJpy: 100, expectancyPositive: true },
    noDrawdownWarning: true,
    noConsecutiveLossWarning: true
  });
  assert.equal(out.runtime.activeTierId, "UNDER_20K");
  assert.equal(out.runtime.candidateTierId, "TIER_20K_50K");
  assert.ok(out.diagnostics.promotionBlockedReasons.includes("confirm_trades_pending"));
});

test("capital scaling promotes after confirmation and good rolling metrics", () => {
  const reached = new Date(Date.now() - 60 * 60_000).toISOString();
  const out = evaluateCapitalScaling({
    state: {
      capitalScalingRuntime: { activeTierId: "UNDER_20K", candidateTierId: "TIER_20K_50K", candidateTierReachedAt: reached },
      trades: trades(35),
      account: { consecutiveLosses: 0 }
    },
    currentBalanceJPY: 21000,
    cfg,
    rolling: { sampleSize: 30, profitFactor: 1.2, expectancyJpy: 100, expectancyPositive: true },
    noDrawdownWarning: true,
    noConsecutiveLossWarning: true
  });
  assert.equal(out.runtime.activeTierId, "TIER_20K_50K");
  assert.equal(out.settingsOverride.riskPercentPerTrade, 4);
  assert.deepEqual(out.settingsOverride.allowedModes, ["BASE", "SEMI"]);
});

test("capital scaling demotes immediately on balance fallback", () => {
  const out = evaluateCapitalScaling({
    state: {
      capitalScalingRuntime: { activeTierId: "TIER_20K_50K", candidateTierId: "TIER_20K_50K" },
      trades: trades(35),
      account: { consecutiveLosses: 0 }
    },
    currentBalanceJPY: 18000,
    cfg,
    rolling: { sampleSize: 30, profitFactor: 1.2, expectancyJpy: 100, expectancyPositive: true },
    noDrawdownWarning: true,
    noConsecutiveLossWarning: true
  });
  assert.equal(out.runtime.activeTierId, "UNDER_20K");
  assert.equal(out.diagnostics.demotionTriggered, true);
});

test("capital scaling allows full trial only in trial tier", () => {
  const out = evaluateCapitalScaling({
    state: {
      capitalScalingRuntime: { activeTierId: "TIER_50K_100K", candidateTierId: "TIER_50K_100K" },
      trades: trades(35),
      account: { consecutiveLosses: 0 }
    },
    currentBalanceJPY: 60000,
    cfg,
    rolling: { sampleSize: 30, profitFactor: 1.15, expectancyJpy: 100, expectancyPositive: true },
    noDrawdownWarning: true,
    noConsecutiveLossWarning: true
  });
  assert.equal(out.diagnostics.fullUnlockStatus, "TRIAL");
  assert.ok(out.settingsOverride.allowedModes.includes("FULL"));
  assert.equal(out.settingsOverride.fullTrialRiskMultiplier, 0.5);
});
