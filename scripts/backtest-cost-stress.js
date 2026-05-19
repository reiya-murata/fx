import { loadState } from "../src/data/store.js";

const PIP_SIZE = 0.01;

function summarize(rows) {
  const totalTrades = rows.length;
  const wins = rows.filter((t) => t.netPnlJpy > 0).length;
  const losses = rows.filter((t) => t.netPnlJpy < 0).length;
  const grossProfitJpy = rows.filter((t) => t.netPnlJpy > 0).reduce((s, t) => s + t.netPnlJpy, 0);
  const grossLossJpy = rows.filter((t) => t.netPnlJpy < 0).reduce((s, t) => s + t.netPnlJpy, 0);
  const netProfitJpy = grossProfitJpy + grossLossJpy;
  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    netProfitJpy: Number(netProfitJpy.toFixed(2)),
    profitFactor: grossLossJpy === 0 ? null : Number((grossProfitJpy / Math.abs(grossLossJpy)).toFixed(4)),
    expectancyJpy: totalTrades > 0 ? Number((netProfitJpy / totalTrades).toFixed(2)) : 0
  };
}

function applyStress(trade, stress) {
  const qty = Math.max(0, Number(trade.qty || 0));
  const extraPips = Number(stress.spreadPips || 0) + Number(stress.slippagePips || 0);
  const extraCostJpy = qty * PIP_SIZE * extraPips;
  const rejectPenaltyRatio = Math.max(0, Number(stress.rejectRateAdd || 0));
  const net = Number(trade.netPnlJpy || 0);
  const adjusted = net * (1 - rejectPenaltyRatio) - extraCostJpy;
  return { ...trade, netPnlJpy: Number(adjusted.toFixed(2)) };
}

const state = loadState();
const trades = (state.trades || []).filter((t) => String(t.exitReason || "").startsWith("auto-"));
const scenarios = [
  { name: "base", spreadPips: 0, slippagePips: 0, rejectRateAdd: 0 },
  { name: "stress_1", spreadPips: 0.2, slippagePips: 0.1, rejectRateAdd: 0.05 },
  { name: "stress_2", spreadPips: 0.4, slippagePips: 0.3, rejectRateAdd: 0.1 },
  { name: "stress_3", spreadPips: 0.6, slippagePips: 0.5, rejectRateAdd: 0.15 }
];

if (!trades.length) {
  console.log(JSON.stringify({
    ok: false,
    reason: "no auto trades"
  }, null, 2));
  process.exit(0);
}

const out = scenarios.map((s) => {
  const stressed = trades.map((t) => applyStress(t, s));
  return {
    scenario: s.name,
    stress: s,
    summary: summarize(stressed)
  };
});

console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  baseTrades: trades.length,
  results: out
}, null, 2));

