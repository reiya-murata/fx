import { analyticsSummary } from "./analytics.js";

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

function trailingLosses(list) {
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (Number(list[i]?.netPnlJpy || 0) < 0) streak += 1;
    else break;
  }
  return streak;
}

export function evaluateDegradationGuard({ trades, memory, cfg = {} }) {
  if (!cfg?.enabled) {
    return {
      enabled: false,
      allowed: true,
      mode: "NORMAL",
      riskMultiplier: 1,
      minConfidenceAdd: 0,
      reason: "degradation guard disabled"
    };
  }

  const lookback = Math.max(10, Number(cfg.lookbackTrades || 36));
  const minTrades = Math.max(8, Number(cfg.minTrades || 20));
  const list = sortedTrades(trades).slice(-lookback);
  if (list.length < minTrades) {
    const ewmaExpectancy = Number(memory?.ewmaExpectancyJpy || 0);
    const severeExpectancy = Number(cfg.severeExpectancyJpy || -260);
    const warningExpectancy = Number(cfg.warningExpectancyJpy || -90);
    const severe = ewmaExpectancy <= severeExpectancy;
    const degraded = !severe && ewmaExpectancy <= warningExpectancy;
    return {
      enabled: true,
      allowed: !(severe && Boolean(cfg.blockOnSevere)),
      mode: severe ? "SEVERE" : (degraded ? "DEGRADED" : "NORMAL"),
      pending: true,
      sampleSize: list.length,
      riskMultiplier: severe
        ? Number(cfg.severeRiskMultiplier || 0.35)
        : (degraded ? Number(cfg.warningRiskMultiplier || 0.65) : 1),
      minConfidenceAdd: severe ? 0.08 : (degraded ? 0.04 : 0),
      reason: severe
        ? "severe degradation detected from ewma expectancy"
        : (degraded ? "degradation warning from ewma expectancy" : `degradation pending: ${list.length}/${minTrades}`)
    };
  }

  const s = analyticsSummary(list);
  const expectancy = s.totalTrades > 0 ? Number(s.netProfitJpy || 0) / s.totalTrades : 0;
  const winRate = Number(s.winRate || 0);
  const lossStreak = trailingLosses(list);
  const severe = expectancy <= Number(cfg.severeExpectancyJpy || -260)
    || winRate <= Number(cfg.severeWinRate || 0.32)
    || lossStreak >= Math.max(2, Number(cfg.severeLossStreak || 6));
  const degraded = !severe && (
    expectancy <= Number(cfg.warningExpectancyJpy || -90)
    || winRate <= Number(cfg.warningWinRate || 0.42)
    || lossStreak >= Math.max(2, Number(cfg.warningLossStreak || 4))
  );

  return {
    enabled: true,
    allowed: !(severe && Boolean(cfg.blockOnSevere)),
    mode: severe ? "SEVERE" : (degraded ? "DEGRADED" : "NORMAL"),
    pending: false,
    sampleSize: list.length,
    expectancyJpy: Number(expectancy.toFixed(2)),
    winRate: Number(winRate.toFixed(4)),
    lossStreak,
    riskMultiplier: Number(clamp(
      severe
        ? Number(cfg.severeRiskMultiplier || 0.35)
        : (degraded ? Number(cfg.warningRiskMultiplier || 0.65) : 1),
      0.05,
      1
    ).toFixed(4)),
    minConfidenceAdd: severe ? 0.08 : (degraded ? 0.04 : 0),
    reason: severe
      ? "severe degradation: throttle/stop"
      : (degraded ? "performance degradation: risk throttled" : "degradation guard normal")
  };
}
