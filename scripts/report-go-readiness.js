import { loadState } from "../src/data/store.js";
import { analyticsSummary, analyticsValidationReport200 } from "../src/services/analytics.js";
import { computeWalkForwardTuning } from "../src/services/walkForward.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { getExecutionTelemetryStats } from "../src/services/executionTelemetry.js";

const PIP_SIZE = 0.01;

function applyStress(trade, stress) {
  const qty = Math.max(0, Number(trade.qty || 0));
  const extraPips = Number(stress.spreadPips || 0) + Number(stress.slippagePips || 0);
  const extraCostJpy = qty * PIP_SIZE * extraPips;
  const rejectPenaltyRatio = Math.max(0, Number(stress.rejectRateAdd || 0));
  const net = Number(trade.netPnlJpy || 0);
  return { ...trade, netPnlJpy: Number((net * (1 - rejectPenaltyRatio) - extraCostJpy).toFixed(2)) };
}

function passCostStress(autoTrades) {
  if (!autoTrades.length) return { pass: false, reason: "no auto trades", summary: null };
  const stressed = autoTrades.map((t) => applyStress(t, { spreadPips: 0.4, slippagePips: 0.3, rejectRateAdd: 0.1 }));
  const s = analyticsSummary(stressed);
  const ev = s.totalTrades > 0 ? s.netProfitJpy / s.totalTrades : 0;
  return {
    pass: ev > 0,
    reason: ev > 0 ? "ev>0 under +0.4 cost stress" : "ev<=0 under +0.4 cost stress",
    summary: {
      trades: s.totalTrades,
      netProfitJpy: Number(s.netProfitJpy || 0),
      profitFactor: s.profitFactor === null ? null : Number(s.profitFactor.toFixed(4)),
      expectancyJpy: Number(ev.toFixed(2))
    }
  };
}

const state = loadState();
const trades = [...(state.trades || [])].sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
const autoTrades = trades.filter((t) => String(t.exitReason || "").startsWith("auto-"));
const wfa = computeWalkForwardTuning(trades, { lookback: 320, minSample: 80 });
const report200 = analyticsValidationReport200(trades, DEFAULT_CONFIG.benchmark);
const execution = getExecutionTelemetryStats({ lookback: 5000 });
const stress = passCostStress(autoTrades);
const oosPf = Number(report200?.summary?.profitFactor || 0);

const checks = {
  executionCalibrated: execution.sampleSize >= 500,
  costStressPlus04: Boolean(stress.pass),
  oosPfAtLeast110: oosPf >= 1.1,
  tradeCountAtLeast1500: autoTrades.length >= 1500,
  walkForwardReady: Boolean(wfa?.apply)
};
const pass = Object.values(checks).every(Boolean);

console.log(JSON.stringify({
  ok: true,
  pass,
  generatedAt: new Date().toISOString(),
  checks,
  diagnostics: {
    autoTrades: autoTrades.length,
    execution,
    costStressPlus04: stress,
    report200,
    walkForward: wfa
  }
}, null, 2));

