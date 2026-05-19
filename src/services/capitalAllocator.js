import { analyticsSummary } from "./analytics.js";
import { computeObjectiveScore } from "./objective.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function allocateRiskPercent({ baseRiskPercent, account, trades, cfg = {}, objectiveCfg = {} }) {
  const base = clamp(Number(baseRiskPercent || 1), 0.1, 100);
  if (!cfg?.enabled) {
    return { enabled: false, riskPercent: base, heatPenalty: 0, objectiveBoost: 0, reason: "capital allocation disabled" };
  }
  const lookback = Math.max(10, Number(cfg.heatLookbackTrades || 40));
  const list = (Array.isArray(trades) ? [...trades] : [])
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0))
    .slice(-lookback);
  const s = analyticsSummary(list);
  const dayPnl = Number(account?.dayPnlJpy || 0);
  const balance = Math.max(1, Number(account?.currentBalanceJpy || 1_000_000));
  const dayLossRatio = dayPnl < 0 ? Math.abs(dayPnl) / balance : 0;
  const ddRatio = Number(s.maxDrawdownJpy || 0) / balance;
  const heatPenalty = clamp(dayLossRatio * 1.8 + ddRatio * 2.1, 0, Number(cfg.maxHeatPenalty || 0.45));
  const avgCost = list.length ? list.reduce((acc, t) => acc + Math.max(0, Number(t.feeJpy || 0)), 0) / list.length : 0;
  const objective = computeObjectiveScore({ summary: s, avgCostJpy: avgCost, cfg: objectiveCfg });
  const objectiveBoost = clamp((Number(objective.normalized || 0.5) - 0.5) * Number(cfg.objectiveBoost || 0.25), -0.2, 0.2);
  const next = base * (1 - heatPenalty + objectiveBoost);
  return {
    enabled: true,
    riskPercent: Number(clamp(next, Number(cfg.minRiskPercent || 1), Number(cfg.maxRiskPercent || 10)).toFixed(4)),
    heatPenalty: Number(heatPenalty.toFixed(4)),
    objectiveBoost: Number(objectiveBoost.toFixed(4)),
    objectiveNormalized: Number(objective.normalized || 0.5),
    reason: "dynamic capital allocation"
  };
}
