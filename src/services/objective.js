function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function computeObjectiveScore({ summary, avgCostJpy = 0, cfg = {} }) {
  if (!cfg?.enabled) {
    return { enabled: false, score: 0, normalized: 0, expectancyJpy: 0, drawdownJpy: 0, avgCostJpy };
  }
  const totalTrades = Math.max(1, toNum(summary?.totalTrades, 0));
  const expectancyJpy = toNum(summary?.netProfitJpy, 0) / totalTrades;
  const drawdownJpy = toNum(summary?.maxDrawdownJpy, 0);
  const cost = Math.max(0, toNum(avgCostJpy, 0));
  const scoreScale = Math.max(1, toNum(cfg.scoreScaleJpy, 1500));
  const drawdownScale = Math.max(1, toNum(cfg.drawdownScaleJpy, 90000));
  const costScale = Math.max(1, toNum(cfg.costScaleJpy, 12000));
  const lambda = clamp(toNum(cfg.lambdaDrawdown, 0.35), 0, 2);
  const mu = clamp(toNum(cfg.muCost, 0.15), 0, 2);
  const score = (expectancyJpy / scoreScale)
    - lambda * (drawdownJpy / drawdownScale)
    - mu * (cost / costScale);
  return {
    enabled: true,
    score: Number(score.toFixed(6)),
    normalized: Number(clamp(0.5 + score, 0, 1).toFixed(6)),
    expectancyJpy: Number(expectancyJpy.toFixed(4)),
    drawdownJpy: Number(drawdownJpy.toFixed(2)),
    avgCostJpy: Number(cost.toFixed(4))
  };
}
