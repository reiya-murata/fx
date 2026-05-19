export function computeAdaptiveTuning(trades, options = {}) {
  const {
    lookback = 200,
    ewmaAlpha = 0.12,
    minSampleSize = 30,
    maxRiskStepPerCycle = 0.06,
    shadowMode = false
  } = options;

  const recent = [...trades]
    .filter((t) => {
      if (t?.entryPrice !== undefined && !(Number(t.entryPrice) > 0)) return false;
      if (t?.exitPrice !== undefined && !(Number(t.exitPrice) > 0)) return false;
      if (t?.qty !== undefined && !(Number(t.qty) > 0)) return false;
      return true;
    })
    .sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime))
    .slice(-lookback);
  if (!recent.length) return baseResult(0, false, shadowMode);

  const pnls = recent.map((t) => Number(t.netPnlJpy) || 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);

  const winRate = ewmaFromSeries(pnls.map((p) => (p > 0 ? 1 : 0)), ewmaAlpha);
  const avgWin = wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgLossAbs = losses.length ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
  const expectancyJpy = winRate * avgWin - (1 - winRate) * avgLossAbs;

  const drawdownRatio = calcDrawdownRatio(recent, 1000000);
  const canApply = recent.length >= minSampleSize && !shadowMode;

  let minRiskRewardDelta = 0;
  let minExpectedValueDelta = 0;
  let confidenceDelta = 0;
  let targetRiskMultiplier = 1;

  if (expectancyJpy < 0) {
    minRiskRewardDelta += 0.2;
    minExpectedValueDelta += 0.12;
    confidenceDelta -= 0.08;
    targetRiskMultiplier *= 0.65;
  } else if (expectancyJpy > 300) {
    minRiskRewardDelta -= 0.05;
    minExpectedValueDelta -= 0.04;
    confidenceDelta += 0.05;
    targetRiskMultiplier *= 1.1;
  }

  if (drawdownRatio > 0.06) {
    minRiskRewardDelta += 0.15;
    minExpectedValueDelta += 0.08;
    confidenceDelta -= 0.07;
    targetRiskMultiplier *= 0.7;
  }

  if (winRate < 0.42) {
    minExpectedValueDelta += 0.06;
    targetRiskMultiplier *= 0.8;
  }

  const boundedRiskMultiplier = limitStep(targetRiskMultiplier, 1, maxRiskStepPerCycle);

  return {
    sampleSize: recent.length,
    apply: canApply,
    shadowMode,
    expectancyJpy,
    winRate,
    drawdownRatio,
    minRiskRewardDelta: canApply ? minRiskRewardDelta : 0,
    minExpectedValueDelta: canApply ? minExpectedValueDelta : 0,
    confidenceDelta: canApply ? confidenceDelta : 0,
    riskMultiplier: canApply ? clamp(boundedRiskMultiplier, 0.3, 1.3) : 1
  };
}

function baseResult(sampleSize, apply, shadowMode) {
  return {
    sampleSize,
    apply,
    shadowMode,
    expectancyJpy: 0,
    winRate: 0,
    drawdownRatio: 0,
    minRiskRewardDelta: 0,
    minExpectedValueDelta: 0,
    confidenceDelta: 0,
    riskMultiplier: 1
  };
}

function ewmaFromSeries(values, alpha) {
  if (!values.length) return 0;
  let acc = values[0];
  for (let i = 1; i < values.length; i += 1) {
    acc = alpha * values[i] + (1 - alpha) * acc;
  }
  return acc;
}

function calcDrawdownRatio(trades, balanceRef) {
  let curve = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    curve += Number(t.netPnlJpy) || 0;
    peak = Math.max(peak, curve);
    maxDd = Math.max(maxDd, peak - curve);
  }
  return maxDd / balanceRef;
}

function limitStep(target, baseline, maxStep) {
  const lower = baseline - maxStep;
  const upper = baseline + maxStep;
  return clamp(target, lower, upper);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
