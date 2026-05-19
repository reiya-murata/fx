function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortedTrades(trades) {
  return (Array.isArray(trades) ? [...trades] : []).sort(
    (a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0)
  );
}

function metricsVector(signal) {
  return {
    confidence: clamp(Number(signal?.confidence || 0), 0, 1),
    rr: Number(signal?.metrics?.rr || 0),
    ev: Number(signal?.metrics?.expectedValuePips || 0),
    spread: Number(signal?.metrics?.spreadPips || 0),
    cost: Number(signal?.metrics?.estimatedCostPips || 0),
    imbalance: Number(signal?.metrics?.orderBookImbalance || 0)
  };
}

function vectorFromTrade(trade) {
  return {
    confidence: clamp(Number(trade?.signalConfidenceCalibrated || trade?.signalConfidence || 0), 0, 1),
    rr: Number(trade?.signalMetrics?.rr || 0),
    ev: Number(trade?.signalMetrics?.expectedValuePips || 0),
    spread: Number(trade?.signalMetrics?.spreadPips || 0),
    cost: Number(trade?.signalMetrics?.estimatedCostPips || 0),
    imbalance: Number(trade?.signalMetrics?.orderBookImbalance || 0)
  };
}

function mean(values = []) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function std(values = []) {
  if (!values.length) return 0;
  const m = mean(values);
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function dist(current, center, scales) {
  const keys = Object.keys(center);
  const s = keys.reduce((acc, k) => {
    const sc = Math.max(1e-6, Number(scales[k] || 1));
    const d = (Number(current[k] || 0) - Number(center[k] || 0)) / sc;
    return acc + d * d;
  }, 0);
  return Math.sqrt(s / Math.max(1, keys.length));
}

function centroid(rows) {
  const keys = ["confidence", "rr", "ev", "spread", "cost", "imbalance"];
  const c = {};
  for (const k of keys) c[k] = mean(rows.map((r) => Number(r[k] || 0)));
  const s = {};
  for (const k of keys) s[k] = Math.max(0.02, std(rows.map((r) => Number(r[k] || 0))));
  return { center: c, scales: s };
}

export function evaluatePatternQualityGate({ signal, trades, cfg = {} }) {
  if (!cfg?.enabled) {
    return { enabled: false, allowed: true, score: 1, sizeMultiplier: 1, reason: "pattern quality disabled" };
  }
  const lookback = Math.max(20, Number(cfg.lookbackTrades || 260));
  const minTrades = Math.max(12, Number(cfg.minTrades || 60));
  const list = sortedTrades(trades).slice(-lookback).filter((t) => t?.signalMetrics);
  if (list.length < minTrades) {
    return {
      enabled: true,
      pending: true,
      allowed: true,
      score: 0.5,
      sizeMultiplier: 1,
      reason: `pattern quality pending: ${list.length}/${minTrades}`
    };
  }

  const wins = list.filter((t) => Number(t.netPnlJpy || 0) > 0).map(vectorFromTrade);
  const losses = list.filter((t) => Number(t.netPnlJpy || 0) <= 0).map(vectorFromTrade);
  if (wins.length < Math.max(6, Math.floor(minTrades * 0.2))) {
    return {
      enabled: true,
      pending: true,
      allowed: true,
      score: 0.5,
      sizeMultiplier: 1,
      reason: "pattern quality pending: insufficient winners"
    };
  }

  const cur = metricsVector(signal);
  const winCent = centroid(wins);
  const lossCent = losses.length ? centroid(losses) : winCent;
  const dWin = dist(cur, winCent.center, winCent.scales);
  const dLoss = dist(cur, lossCent.center, lossCent.scales);
  const raw = clamp(1 / (1 + dWin) - 1 / (1 + dLoss) + 0.5, 0, 1);
  const minScore = clamp(Number(cfg.minScore || 0.5), 0.05, 0.95);
  const allowed = raw >= minScore;
  const sizeMultiplier = Number(clamp(0.25 + raw * 0.9, Number(cfg.minSizeMultiplier || 0.25), 1).toFixed(4));

  return {
    enabled: true,
    pending: false,
    allowed,
    score: Number(raw.toFixed(4)),
    minScore,
    distanceToWins: Number(dWin.toFixed(4)),
    distanceToLosses: Number(dLoss.toFixed(4)),
    sizeMultiplier,
    reason: allowed ? "pattern quality pass" : "pattern quality below threshold"
  };
}

