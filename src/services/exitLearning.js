function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jstHour(isoTs) {
  const t = new Date(isoTs || Date.now()).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).getUTCHours();
}

function session(isoTs) {
  const h = jstHour(isoTs);
  if (h >= 9 && h < 15) return "TOKYO";
  if (h >= 15 && h < 22) return "LONDON";
  return "NY";
}

export function buildExitLearningAdjustment({ signal, trades, now = new Date(), cfg = {} }) {
  if (!cfg?.enabled) return disabled();
  const lookback = Math.max(20, Number(cfg.lookbackTrades || 120));
  const minTrades = Math.max(8, Number(cfg.minTrades || 20));
  const list = (Array.isArray(trades) ? [...trades] : [])
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0))
    .slice(-lookback);
  if (list.length < minTrades) return { ...disabled(), pending: true, sampleSize: list.length, reason: `exit-learning pending: ${list.length}/${minTrades}` };

  const reg = String(signal?.regime || "UNKNOWN");
  const sess = session(now.toISOString());
  const same = list.filter((t) => String(t?.regime || "") === reg && session(t.exitTime || t.entryTime || now.toISOString()) === sess);
  const bucket = same.length >= minTrades ? same : list;
  const wins = bucket.filter((t) => Number(t.netPnlJpy || 0) > 0).length;
  const winRate = wins / Math.max(1, bucket.length);
  const avgHold = bucket.reduce((s, t) => s + Number(t.holdingSeconds || 0), 0) / Math.max(1, bucket.length);
  const peakTakes = bucket.filter((t) => String(t.exitReason || "").includes("peak") || String(t.exitReason || "").includes("take")).length;
  const stopLosses = bucket.filter((t) => String(t.exitReason || "").includes("sl") || String(t.exitReason || "").includes("risk")).length;
  const peakRate = peakTakes / Math.max(1, bucket.length);
  const stopRate = stopLosses / Math.max(1, bucket.length);

  const holdMultiplier = clamp(
    1 + (winRate - 0.5) * 0.35 + (peakRate - stopRate) * 0.28 + clamp((avgHold - 90) / 300, -0.2, 0.2),
    Math.max(0.85, Number(cfg.minHoldMultiplier || 0.85)),
    Math.min(1.2, Number(cfg.maxHoldMultiplier || 1.2))
  );
  const tpAdjust = clamp((peakRate - 0.22) * 0.18, -Math.min(0.1, Number(cfg.tpAdjustMax || 0.1)), Math.min(0.1, Number(cfg.tpAdjustMax || 0.1)));
  const slAdjust = clamp((stopRate - 0.22) * -0.16, -Math.min(0.1, Number(cfg.slAdjustMax || 0.1)), Math.min(0.1, Number(cfg.slAdjustMax || 0.1)));
  const smoothing = clamp(Number(cfg.slowUpdateSmoothing || 0.75), 0.5, 0.95);
  const holdTarget = Number(holdMultiplier.toFixed(4));
  const tpTarget = Number((1 + tpAdjust).toFixed(4));
  const slTarget = Number((1 + slAdjust).toFixed(4));
  return {
    enabled: true,
    pending: false,
    sampleSize: bucket.length,
    holdMultiplier: Number((1 * smoothing + holdTarget * (1 - smoothing)).toFixed(4)),
    tpMultiplier: Number((1 * smoothing + tpTarget * (1 - smoothing)).toFixed(4)),
    slMultiplier: Number((1 * smoothing + slTarget * (1 - smoothing)).toFixed(4)),
    reason: "exit learning adjustment"
  };
}

function disabled() {
  return {
    enabled: false,
    pending: false,
    sampleSize: 0,
    holdMultiplier: 1,
    tpMultiplier: 1,
    slMultiplier: 1,
    reason: "exit learning disabled"
  };
}
