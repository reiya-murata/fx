import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEdgeSizingMultiplier,
  computeTailPenaltyMultiplier,
  computeTailAwareSizeDown,
  evaluateKillSwitch,
  evaluateNoTradeZoneSchedule,
  evaluateRollingExpectancy
} from "../src/services/autoSafety.js";
import { evaluateTrendEngine } from "../src/engine/trendEngine.js";
import { computeAtrTrailingStop, computePartialExitPlan } from "../src/engine/autoExit.js";

function mkTrade({ pnl = -100, i = 0 }) {
  return {
    netPnlJpy: pnl,
    exitReason: "auto-ttl",
    exitTime: new Date(2026, 0, 1, 0, i).toISOString()
  };
}

test("kill switch triggers at drawdown threshold", () => {
  const out = evaluateKillSwitch({
    state: {
      account: { initialBalanceJpy: 1_000_000, currentBalanceJpy: 940_000 },
      trades: []
    },
    cfg: { enabled: true, ddStopPercent: 0.05, consecutiveLossStop: 10 }
  });
  assert.equal(out.shouldStop, true);
});

test("kill switch triggers at trailing 10 losses", () => {
  const trades = Array.from({ length: 10 }, (_, i) => mkTrade({ pnl: -100 - i, i }));
  const out = evaluateKillSwitch({
    state: {
      account: { initialBalanceJpy: 1_000_000, currentBalanceJpy: 995_000 },
      trades
    },
    cfg: { enabled: true, ddStopPercent: 0.05, consecutiveLossStop: 10 }
  });
  assert.equal(out.shouldStop, true);
});

test("rolling expectancy triggers stop on 3rd consecutive breakdown", () => {
  const trades = [];
  for (let i = 0; i < 75; i += 1) {
    trades.push(mkTrade({ pnl: i < 70 ? -220 : -50, i }));
  }
  const out = evaluateRollingExpectancy({
    trades,
    cfg: {
      enabled: true,
      lookbackTrades: 25,
      minTrades: 20,
      stopConsecutiveBreakdown: 3
    }
  });
  assert.equal(out.shouldStop, true);
  assert.equal(out.consecutiveBreakdown, 3);
});

test("rolling expectancy throttles risk on first breakdown", () => {
  const trades = [];
  for (let i = 0; i < 25; i += 1) trades.push(mkTrade({ pnl: i < 20 ? -220 : 60, i }));
  const out = evaluateRollingExpectancy({
    trades,
    cfg: {
      enabled: true,
      lookbackTrades: 25,
      minTrades: 20,
      hardStopExpectancyJpy: 0,
      hardStopProfitFactor: 1.05,
      throttleRiskMultiplier: 0.25
    }
  });
  assert.equal(out.shouldStop, false);
  assert.ok(out.shouldThrottle || out.shouldRescue);
  assert.ok(out.riskMultiplier <= 0.25);
});

test("rolling expectancy can enter rescue stage with cooldown", () => {
  const trades = [];
  for (let i = 0; i < 30; i += 1) trades.push(mkTrade({ pnl: i < 26 ? -180 : 20, i }));
  const out = evaluateRollingExpectancy({
    trades,
    cfg: {
      enabled: true,
      lookbackTrades: 30,
      minTrades: 20,
      warningProfitFactor: 1.03,
      warningExpectancyR: -0.01,
      rescueProfitFactor: 1.01,
      rescueExpectancyR: -0.015,
      rescueRiskMultiplier: 0.15,
      rescueCooldownSec: 1800,
      stopConsecutiveBreakdown: 4
    }
  });
  assert.equal(out.shouldRescue, true);
  assert.equal(out.riskMultiplier, 0.15);
  assert.equal(out.rescueCooldownSec, 1800);
});

test("rolling expectancy throttles harder on second consecutive breakdown", () => {
  const trades = [];
  for (let i = 0; i < 50; i += 1) {
    trades.push(mkTrade({ pnl: i < 45 ? -220 : -50, i }));
  }
  const out = evaluateRollingExpectancy({
    trades,
    cfg: {
      enabled: true,
      lookbackTrades: 25,
      minTrades: 20,
      throttleRiskMultiplier: 0.25,
      extremeRiskMultiplier: 0.1,
      stopConsecutiveBreakdown: 3
    }
  });
  assert.equal(out.shouldStop, false);
  assert.ok(out.shouldThrottle || out.shouldRescue);
  assert.equal(out.consecutiveBreakdown, 2);
  assert.ok(out.riskMultiplier <= 0.25);
});

test("noTradeZone schedule blocks and returns reason code", () => {
  const out = evaluateNoTradeZoneSchedule("2026-02-15T20:20:00.000Z", {
    enabled: true,
    hardBlockWindowsJst: ["05:00-06:30"],
    sizeDownWindowsJst: ["11:00-13:30"],
    sizeDownMultiplier: 0.5
  });
  assert.equal(out.blocked, true);
  assert.equal(out.reasonCode, "SCHEDULE_HARD_BLOCK");
});

test("edge sizing multiplier is clamped to 0.5..2.0", () => {
  const hi = computeEdgeSizingMultiplier({
    regimeConfidence: 2,
    ensembleAgreement: 2,
    executionQualityScore: 2,
    nearTailThreshold: false
  });
  const lo = computeEdgeSizingMultiplier({
    regimeConfidence: 0.1,
    ensembleAgreement: 0.1,
    executionQualityScore: 0.1,
    nearTailThreshold: false
  });
  assert.equal(hi.sizingMultiplier, 2);
  assert.equal(lo.sizingMultiplier, 0.5);
});

test("trend pullback rule can block immediate breakout entry", () => {
  const out = evaluateTrendEngine({
    regime: "TREND_UP",
    ask: 150.12,
    bid: 150.1,
    atrValue: 0.05,
    marketFeatures: { momentumScore: 0.03, bbZ1m: 3.2 },
    config: {
      pipSize: 0.01,
      exit: { stopAtrMultiplier: 1.2, tpAtrMultiplier: 1.8 },
      trendPullback: { enabled: true, breakoutBbZ: 2.6, retraceBbZ: 1.1, minMomentumResume: 0.08 }
    },
    regimeProfile: { stopAtrMultiplier: 1.1, tpAtrMultiplier: 2.0 }
  });
  assert.equal(out.action, "HOLD");
});

test("partial exit triggers at configured R and atr trailing only tightens", () => {
  const plan = computePartialExitPlan({
    pnlPips: 1.1,
    riskPips: 1,
    qty: 1000,
    cfg: { firstTakeR: 1, firstTakePortion: 0.5, minRemainingQty: 1 },
    degraded: false,
    minOrderQty: 1,
    minRemainingQty: 1
  });
  assert.equal(plan.shouldPartial, true);
  assert.equal(plan.closeQty, 500);

  const next1 = computeAtrTrailingStop({
    side: "BUY",
    exitPrice: 150.2,
    currentStopLoss: 150.0,
    atrValue: 0.04,
    atrMultiplier: 2.0,
    pipSize: 0.01
  });
  const next2 = computeAtrTrailingStop({
    side: "BUY",
    exitPrice: 150.15,
    currentStopLoss: next1,
    atrValue: 0.04,
    atrMultiplier: 2.0,
    pipSize: 0.01
  });
  assert.ok(next2 >= next1);
});

test("tail-aware size down activates within specified ranges", () => {
  const m1 = computeTailAwareSizeDown({
    p95PipelineLatencyMs: 800,
    p95SlippagePips: 0.2,
    targetSlippagePips: 0.2
  });
  const m2 = computeTailAwareSizeDown({
    p95PipelineLatencyMs: 600,
    p95SlippagePips: 0.33,
    targetSlippagePips: 0.2
  });
  assert.ok(m1 <= 0.75 && m1 >= 0.5);
  assert.ok(m2 < 1 && m2 >= 0.5);
});

test("unified tail penalty multiplier scales down but remains bounded", () => {
  const m = computeTailPenaltyMultiplier({
    p95PipelineLatencyMs: 950,
    p99PipelineLatencyMs: 1300,
    rejectRate: 0.09,
    p95SlippagePips: 0.45,
    targetSlippagePips: 0.2,
    cfg: {
      p95LatencyStartMs: 700,
      p95LatencyEndMs: 1000,
      p95LatencyMinMultiplier: 0.5,
      p99LatencyStartMs: 1100,
      p99LatencyEndMs: 1400,
      p99LatencyMinMultiplier: 0.6,
      slippageStartMultiplier: 1.5,
      slippageEndMultiplier: 2.5,
      slippageMinMultiplier: 0.5,
      rejectRateStart: 0.05,
      rejectRateEnd: 0.12,
      rejectRateMinMultiplier: 0.4,
      minMultiplier: 0.35
    }
  });
  assert.ok(m <= 1 && m >= 0.35);
});
