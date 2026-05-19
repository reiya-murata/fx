import { readFileSync, existsSync } from "node:fs";

const PIP_SIZE = 0.01;

function argValue(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function loadState(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function sortedAutoTrades(state) {
  return (Array.isArray(state?.trades) ? state.trades : [])
    .filter((t) => String(t?.exitReason || "").startsWith("auto-"))
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
}

function expectancyInR(trades) {
  if (!trades.length) return 0;
  const wins = trades.filter((t) => Number(t.netPnlJpy || 0) > 0).map((t) => Number(t.netPnlJpy || 0));
  const losses = trades.filter((t) => Number(t.netPnlJpy || 0) < 0).map((t) => Math.abs(Number(t.netPnlJpy || 0)));
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 1;
  if (!(avgLoss > 0)) return 0;
  const p = wins.length / trades.length;
  const avgWinR = wins.length ? (wins.reduce((s, v) => s + v, 0) / wins.length) / avgLoss : 0;
  return p * avgWinR - (1 - p);
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function summarize(trades, initialBalanceJpy = 1_000_000) {
  const pnls = trades.map((t) => Number(t.netPnlJpy || 0));
  const totalTrades = pnls.length;
  const wins = pnls.filter((v) => v > 0);
  const losses = pnls.filter((v) => v < 0);
  const grossProfit = wins.reduce((s, v) => s + v, 0);
  const grossLoss = losses.reduce((s, v) => s + v, 0);
  const net = grossProfit + grossLoss;
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const returns = pnls.map((p) => p / Math.max(1, Number(initialBalanceJpy || 1_000_000)));
  const meanRet = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const stdRet = sampleStd(returns);
  const downside = returns.filter((r) => r < 0);
  const downsideStd = sampleStd(downside);
  const sharpe = stdRet > 0 ? meanRet / stdRet : 0;
  const sortino = downsideStd > 0 ? meanRet / downsideStd : 0;
  return {
    trades: totalTrades,
    winRate: totalTrades ? Number((wins.length / totalTrades).toFixed(4)) : 0,
    netProfitJpy: Number(net.toFixed(2)),
    profitFactor: grossLoss === 0 ? null : Number((grossProfit / Math.abs(grossLoss)).toFixed(4)),
    expectancyJpy: totalTrades ? Number((net / totalTrades).toFixed(2)) : 0,
    expectancyR: Number(expectancyInR(trades).toFixed(6)),
    maxDrawdownJpy: Number(maxDd.toFixed(2)),
    sharpe: Number(sharpe.toFixed(4)),
    sortino: Number(sortino.toFixed(4))
  };
}

function byKey(trades, key) {
  const map = new Map();
  for (const t of trades) {
    const k = String(t?.[key] || "UNKNOWN");
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return Object.fromEntries(
    [...map.entries()]
      .map(([k, list]) => [k, summarize(list)])
      .sort((a, b) => Number(b[1].netProfitJpy || 0) - Number(a[1].netProfitJpy || 0))
  );
}

function applyStress(trades, factor = 1) {
  const spreadAdd = 0.2 * factor;
  const slipAdd = 0.1 * factor;
  const rejectAdd = 0.05 * factor;
  return trades.map((t) => {
    const qty = Math.max(0, Number(t.qty || 0));
    const extraPips = spreadAdd + slipAdd;
    const extraCost = qty * PIP_SIZE * extraPips;
    const net = Number(t.netPnlJpy || 0);
    return {
      ...t,
      netPnlJpy: Number((net * (1 - rejectAdd) - extraCost).toFixed(2))
    };
  });
}

function splitOos(trades) {
  if (trades.length < 10) return { inSample: trades, oos: [] };
  const cut = Math.max(1, Math.floor(trades.length * 0.7));
  return {
    inSample: trades.slice(0, cut),
    oos: trades.slice(cut)
  };
}

function datasetReport(state) {
  const trades = sortedAutoTrades(state);
  const initial = Number(state?.account?.initialBalanceJpy || 1_000_000);
  const split = splitOos(trades);
  return {
    summary: summarize(trades, initial),
    inSample: summarize(split.inSample, initial),
    oos: summarize(split.oos, initial),
    bySession: byKey(trades, "executionSession"),
    byRegime: byKey(trades, "regime"),
    byEventTag: byKey(trades, "executionEventTag"),
    stress: {
      x1_5: summarize(applyStress(trades, 1.5), initial),
      x2_0: summarize(applyStress(trades, 2.0), initial)
    }
  };
}

const afterPath = argValue("--after", "data/state.json");
const beforePathArg = argValue("--before", "");
const beforePath = beforePathArg && existsSync(beforePathArg) ? beforePathArg : afterPath;

const before = loadState(beforePath);
const after = loadState(afterPath);

const beforeReport = datasetReport(before);
const afterReport = datasetReport(after);

function pickCore(x) {
  return {
    Net: x.netProfitJpy,
    PF: x.profitFactor,
    ExpectancyR: x.expectancyR,
    MaxDD: x.maxDrawdownJpy,
    Trades: x.trades,
    Sharpe: x.sharpe,
    Sortino: x.sortino
  };
}

console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  note: beforePath === afterPath
    ? "before snapshot not provided; using same dataset for harness output"
    : "before/after compared on provided snapshots",
  input: { beforePath, afterPath },
  comparison: {
    before: pickCore(beforeReport.summary),
    after: pickCore(afterReport.summary),
    delta: {
      Net: Number((afterReport.summary.netProfitJpy - beforeReport.summary.netProfitJpy).toFixed(2)),
      PF: Number(((afterReport.summary.profitFactor || 0) - (beforeReport.summary.profitFactor || 0)).toFixed(4)),
      ExpectancyR: Number((afterReport.summary.expectancyR - beforeReport.summary.expectancyR).toFixed(6)),
      MaxDD: Number((afterReport.summary.maxDrawdownJpy - beforeReport.summary.maxDrawdownJpy).toFixed(2)),
      Trades: Number(afterReport.summary.trades - beforeReport.summary.trades)
    }
  },
  afterDetail: afterReport
}, null, 2));
