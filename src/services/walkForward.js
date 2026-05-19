function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function scoreTrades(trades) {
  if (!trades.length) return -1e9;
  const pnls = trades.map((t) => Number(t.netPnlJpy) || 0);
  const sum = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const wr = wins / pnls.length;
  const drawdownPenalty = estimateMaxDrawdown(pnls) * 0.35;
  return sum * 0.001 + (wr - 0.5) * 20 - drawdownPenalty;
}

function estimateMaxDrawdown(pnls) {
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return maxDd / 1000;
}

export function computeWalkForwardTuning(trades, options = {}) {
  const lookback = Number(options.lookback || 240);
  const minSample = Number(options.minSample || 60);
  const list = (Array.isArray(trades) ? trades : [])
    .sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime))
    .slice(-lookback);
  if (list.length < minSample) {
    return {
      apply: false,
      sampleSize: list.length,
      minRiskRewardDelta: 0,
      minExpectedValueDelta: 0,
      confidenceDelta: 0
    };
  }

  const trainSize = Math.floor(list.length * 0.7);
  const train = list.slice(0, trainSize);
  const test = list.slice(trainSize);
  const baseScore = scoreTrades(test);

  const candidates = [
    { rr: 0, ev: 0, conf: 0 },
    { rr: 0.08, ev: 0.03, conf: -0.01 },
    { rr: 0.15, ev: 0.06, conf: -0.02 },
    { rr: -0.04, ev: -0.02, conf: 0.01 }
  ];

  let best = { rr: 0, ev: 0, conf: 0, score: baseScore };
  for (const c of candidates) {
    const filtered = test.filter((t) => {
      const rr = Number(t?.signalMetrics?.rr || 1);
      const ev = Number(t?.signalMetrics?.expectedValuePips || 0);
      const conf = Number(t?.signalConfidence || 0.5);
      return rr >= (1.2 + c.rr) && ev >= (0.1 + c.ev) && conf >= (0.45 + c.conf);
    });
    const s = scoreTrades(filtered);
    if (s > best.score) best = { ...c, score: s };
  }

  return {
    apply: true,
    sampleSize: list.length,
    minRiskRewardDelta: Number(clamp(best.rr, -0.1, 0.25).toFixed(4)),
    minExpectedValueDelta: Number(clamp(best.ev, -0.05, 0.12).toFixed(4)),
    confidenceDelta: Number(clamp(best.conf, -0.05, 0.05).toFixed(4)),
    baseScore: Number(baseScore.toFixed(4)),
    tunedScore: Number(best.score.toFixed(4)),
    trainSample: train.length,
    testSample: test.length
  };
}

