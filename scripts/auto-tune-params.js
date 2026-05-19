import { loadState } from "../src/data/store.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function scoreTrades(trades) {
  if (!trades.length) return -1e9;
  const pnls = trades.map((t) => Number(t.netPnlJpy || 0));
  const net = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter((v) => v > 0).length;
  const wr = wins / pnls.length;
  const avgCost = trades.reduce((s, t) => s + Math.max(0, Number(t.feeJpy || 0)), 0) / trades.length;
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return net * 0.001 + (wr - 0.5) * 18 - (maxDd / 40000) - (avgCost / 2500);
}

function passTrade(t, p) {
  const conf = Number(t.signalConfidenceCalibrated || t.signalConfidence || 0.5);
  const ev = Number(t?.signalMetrics?.expectedValuePips || 0);
  const cost = Number(t?.signalMetrics?.estimatedCostPips || 0);
  const stress = Number(t.executionStress || 0);
  return conf >= p.minConfidence
    && (ev - cost * p.costBufferMultiplier) >= p.minNetEdgePips
    && stress <= p.maxExecutionStress;
}

function evaluateCandidates(trades, candidates, folds = 5) {
  const list = [...trades].sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
  const foldSize = Math.max(1, Math.floor(list.length / folds));
  let best = null;

  for (const c of candidates) {
    const foldScores = [];
    for (let i = 0; i < folds; i += 1) {
      const start = i * foldSize;
      const end = i === (folds - 1) ? list.length : (i + 1) * foldSize;
      const test = list.slice(start, end);
      if (!test.length) continue;
      const selected = test.filter((t) => passTrade(t, c));
      if (selected.length < Math.max(4, Math.floor(test.length * 0.08))) {
        foldScores.push(-999);
        continue;
      }
      foldScores.push(scoreTrades(selected));
    }
    if (!foldScores.length) continue;
    const avgScore = foldScores.reduce((s, v) => s + v, 0) / foldScores.length;
    const scoreStd = Math.sqrt(foldScores.reduce((s, v) => s + (v - avgScore) ** 2, 0) / foldScores.length);
    const robust = avgScore - scoreStd * 0.35;
    if (!best || robust > best.robustScore) {
      best = {
        params: c,
        avgScore: Number(avgScore.toFixed(4)),
        scoreStd: Number(scoreStd.toFixed(4)),
        robustScore: Number(robust.toFixed(4))
      };
    }
  }

  return best;
}

function buildCandidates() {
  const out = [];
  for (const minConfidence of [0.5, 0.52, 0.55, 0.58, 0.62]) {
    for (const minNetEdgePips of [0.05, 0.08, 0.12, 0.16]) {
      for (const maxExecutionStress of [1.1, 1.3, 1.5, 1.7]) {
        for (const costBufferMultiplier of [0.1, 0.15, 0.2, 0.3]) {
          out.push({ minConfidence, minNetEdgePips, maxExecutionStress, costBufferMultiplier });
        }
      }
    }
  }
  return out;
}

const state = loadState();
const trades = (state.trades || []).filter((t) => Number.isFinite(Number(t.netPnlJpy)));
const minTrades = 80;

if (trades.length < minTrades) {
  console.log(JSON.stringify({
    ok: false,
    reason: `not enough trades: ${trades.length} < ${minTrades}`,
    hint: "collect more trades, then rerun"
  }, null, 2));
  process.exit(0);
}

const best = evaluateCandidates(trades, buildCandidates(), 5);
if (!best) {
  console.log(JSON.stringify({
    ok: false,
    reason: "no candidate found"
  }, null, 2));
  process.exit(0);
}

const recommended = {
  preTradeGuard: {
    baseMinConfidence: Number(clamp(best.params.minConfidence, 0.4, 0.8).toFixed(2)),
    minNetEdgePips: Number(best.params.minNetEdgePips.toFixed(3)),
    maxExecutionStress: Number(best.params.maxExecutionStress.toFixed(2)),
    costBufferMultiplier: Number(best.params.costBufferMultiplier.toFixed(2))
  }
};

console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  sampleTrades: trades.length,
  best,
  recommended
}, null, 2));

