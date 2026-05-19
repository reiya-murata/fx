import { analyticsSummary } from "./analytics.js";
import { computeWalkForwardTuning } from "./walkForward.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortedTrades(trades) {
  return (Array.isArray(trades) ? [...trades] : [])
    .filter((t) => {
      if (t?.entryPrice !== undefined && !(Number(t.entryPrice) > 0)) return false;
      if (t?.exitPrice !== undefined && !(Number(t.exitPrice) > 0)) return false;
      if (t?.qty !== undefined && !(Number(t.qty) > 0)) return false;
      return true;
    })
    .sort(
    (a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0)
  );
}

export function evaluateWalkForwardGate(trades, cfg = {}) {
  const enforce = Boolean(cfg.enforceForAuto);
  const blockWhenInsufficient = Boolean(cfg.blockWhenInsufficient);
  const lookback = Math.max(60, Number(cfg.lookbackTrades || 320));
  const minTrades = Math.max(20, Number(cfg.minTrades || 80));
  const oosRatio = clamp(Number(cfg.oosRatio || 0.3), 0.2, 0.5);

  const list = sortedTrades(trades).slice(-lookback);
  if (list.length < minTrades) {
    const allowed = !(enforce && blockWhenInsufficient);
    return {
      allowed,
      enforce,
      pending: true,
      pass: false,
      reason: `WFA判定待ち: ${list.length}/${minTrades}`,
      sampleSize: list.length
    };
  }

  const oosSize = Math.max(10, Math.round(list.length * oosRatio));
  const oos = list.slice(-oosSize);
  const oosSummary = analyticsSummary(oos);
  const oosExpectancyJpy = oosSummary.totalTrades > 0
    ? Number((oosSummary.netProfitJpy / oosSummary.totalTrades).toFixed(2))
    : 0;
  const walkForward = computeWalkForwardTuning(list, { lookback, minSample: minTrades });
  const scoreImprovement = Number(((walkForward.tunedScore || 0) - (walkForward.baseScore || 0)).toFixed(4));

  const checks = {
    oosWinRate: Number(oosSummary.winRate || 0) >= Number(cfg.minOosWinRate || 0.5),
    oosProfitFactor: Number(oosSummary.profitFactor || 0) >= Number(cfg.minOosProfitFactor || 1.1),
    oosExpectancy: oosExpectancyJpy >= Number(cfg.minOosExpectancyJpy || 0),
    oosDrawdown: Number(oosSummary.maxDrawdownJpy || 0) <= Number(cfg.maxOosDrawdownJpy || 90000),
    tuningImprovement: scoreImprovement >= Number(cfg.minScoreImprovement || 0)
  };
  const pass = Object.values(checks).every(Boolean);

  return {
    allowed: !enforce || pass,
    enforce,
    pending: false,
    pass,
    reason: pass ? "WFA OOS pass" : "WFA OOS未達のため自動抑制",
    sampleSize: list.length,
    oosTrades: oos.length,
    oosExpectancyJpy,
    oosSummary,
    scoreImprovement,
    checks
  };
}

export function evaluateExpectancyGate(trades, cfg = {}, memory = null) {
  const enabled = Boolean(cfg.enabled);
  if (!enabled) {
    return {
      allowed: true,
      enabled: false,
      pending: false,
      reason: "expectancy gate disabled"
    };
  }

  const lookback = Math.max(10, Number(cfg.lookbackTrades || 48));
  const minTrades = Math.max(5, Number(cfg.minTrades || 20));
  const startupNoBlockTrades = Math.max(0, Number(cfg.startupNoBlockTrades || 0));
  const recent = sortedTrades(trades).slice(-lookback);
  if (recent.length < minTrades) {
    const memTrades = Number(memory?.totalTrades || 0);
    if (memTrades >= minTrades) {
      const memExpectancy = Number(memory?.ewmaExpectancyJpy || 0);
      const memWinRate = Number(memory?.ewmaWinRate || 0);
      const memPf = Number(memory?.ewmaProfitFactor || 0);
      const blockOnCompressedMemoryFail = Boolean(cfg.blockOnCompressedMemoryFail);
      const pass = memExpectancy >= Number(cfg.minExpectancyJpy || 80)
        && memWinRate >= Number(cfg.minWinRate || 0.44)
        && memPf >= Number(cfg.minProfitFactor || 1.02);
      const allowByBootstrapPolicy = !pass && !blockOnCompressedMemoryFail;
      return {
        allowed: pass || allowByBootstrapPolicy,
        enabled: true,
        pending: allowByBootstrapPolicy,
        pass,
        source: "learning-memory",
        reason: pass
          ? "expectancy gate pass (compressed memory)"
          : (allowByBootstrapPolicy
            ? "期待値ゲート参考（compressed memory: warn-only）"
            : "期待値ゲート未達（compressed memory）"),
        sampleSize: recent.length,
        memorySampleSize: memTrades,
        expectancyJpy: memExpectancy,
        warnOnly: allowByBootstrapPolicy,
        summary: {
          winRate: memWinRate,
          profitFactor: memPf
        },
        checks: {
          expectancy: memExpectancy >= Number(cfg.minExpectancyJpy || 80),
          winRate: memWinRate >= Number(cfg.minWinRate || 0.44),
          profitFactor: memPf >= Number(cfg.minProfitFactor || 1.02),
          drawdown: true
        }
      };
    }
    return {
      allowed: true,
      enabled: true,
      pending: true,
      reason: `期待値判定待ち: ${recent.length}/${minTrades}`,
      sampleSize: recent.length
    };
  }

  const summary = analyticsSummary(recent);
  const expectancyJpy = summary.totalTrades > 0
    ? Number((summary.netProfitJpy / summary.totalTrades).toFixed(2))
    : 0;
  const checks = {
    expectancy: expectancyJpy >= Number(cfg.minExpectancyJpy || 80),
    winRate: Number(summary.winRate || 0) >= Number(cfg.minWinRate || 0.44),
    profitFactor: Number(summary.profitFactor || 0) >= Number(cfg.minProfitFactor || 1.02),
    drawdown: Number(summary.maxDrawdownJpy || 0) <= Number(cfg.maxDrawdownJpy || 70000)
  };
  const pass = Object.values(checks).every(Boolean);
  const totalTrades = Array.isArray(trades) ? trades.length : 0;
  const startupGrace = !pass && startupNoBlockTrades > 0 && totalTrades < startupNoBlockTrades;

  return {
    allowed: pass || startupGrace,
    enabled: true,
    pending: startupGrace,
    pass,
    reason: pass
      ? "expectancy gate pass"
      : (startupGrace
        ? `期待値ゲート警告（初期運用猶予: ${totalTrades}/${startupNoBlockTrades}）`
        : "期待値ゲート未達のためエントリー抑制"),
    sampleSize: recent.length,
    totalTrades,
    expectancyJpy,
    summary,
    checks,
    warnOnly: startupGrace
  };
}
