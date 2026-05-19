import { loadState } from "../src/data/store.js";
import { analyticsSummary } from "../src/services/analytics.js";
import { computeWalkForwardTuning } from "../src/services/walkForward.js";

const folds = Math.max(3, Math.min(12, Number(process.argv[2] || 6)));
const minTrades = Math.max(30, Number(process.argv[3] || 60));

const state = loadState();
const trades = [...(state.trades || [])].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));

if (trades.length < minTrades) {
  console.log(JSON.stringify({
    ok: false,
    reason: `not enough trades: ${trades.length} < ${minTrades}`,
    folds,
    minTrades
  }, null, 2));
  process.exit(0);
}

const foldSize = Math.max(10, Math.floor(trades.length / folds));
const reports = [];

for (let i = 0; i < folds; i += 1) {
  const testStart = i * foldSize;
  const testEnd = i === folds - 1 ? trades.length : Math.min(trades.length, (i + 1) * foldSize);
  const test = trades.slice(testStart, testEnd);
  const train = trades.slice(0, testStart);
  if (test.length < 10 || train.length < 20) continue;

  const tune = computeWalkForwardTuning(train, {
    lookback: Math.min(400, train.length),
    minSample: Math.max(40, Math.floor(train.length * 0.25))
  });
  const testSummary = analyticsSummary(test);

  reports.push({
    fold: i + 1,
    trainTrades: train.length,
    testTrades: test.length,
    tuning: tune,
    test: {
      winRate: Number(testSummary.winRate.toFixed(4)),
      netProfitJpy: Number(testSummary.netProfitJpy.toFixed(2)),
      profitFactor: testSummary.profitFactor === null ? null : Number(testSummary.profitFactor.toFixed(4)),
      maxDrawdownJpy: Number(testSummary.maxDrawdownJpy.toFixed(2))
    }
  });
}

const whole = analyticsSummary(trades);
console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  totalTrades: trades.length,
  folds,
  reports,
  whole: {
    winRate: Number(whole.winRate.toFixed(4)),
    netProfitJpy: Number(whole.netProfitJpy.toFixed(2)),
    profitFactor: whole.profitFactor === null ? null : Number(whole.profitFactor.toFixed(4)),
    maxDrawdownJpy: Number(whole.maxDrawdownJpy.toFixed(2))
  }
}, null, 2));
