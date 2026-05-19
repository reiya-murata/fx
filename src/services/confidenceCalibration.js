function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortedTrades(trades) {
  return (Array.isArray(trades) ? [...trades] : []).sort(
    (a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0)
  );
}

export function buildConfidenceCalibration({ trades, cfg = {} }) {
  if (!cfg?.enabled) {
    return disabled("confidence calibration disabled");
  }
  const lookback = Math.max(20, Number(cfg.lookbackTrades || 300));
  const minTrades = Math.max(10, Number(cfg.minTrades || 50));
  const bins = Math.max(3, Math.min(12, Number(cfg.bins || 6)));
  const shrinkage = Math.max(1, Number(cfg.shrinkage || 20));
  const list = sortedTrades(trades).slice(-lookback).filter((t) =>
    Number.isFinite(Number(t?.signalConfidence))
  );
  if (list.length < minTrades) {
    return {
      ...disabled(`calibration pending: ${list.length}/${minTrades}`),
      pending: true,
      sampleSize: list.length
    };
  }

  const bucket = Array.from({ length: bins }, () => ({ n: 0, wins: 0, avgRaw: 0 }));
  for (const t of list) {
    const raw = clamp(Number(t.signalConfidence || 0), 0, 1);
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(raw * bins)));
    const b = bucket[idx];
    b.n += 1;
    b.wins += Number(t.netPnlJpy || 0) > 0 ? 1 : 0;
    b.avgRaw += raw;
  }

  const globalWinRate = list.filter((t) => Number(t.netPnlJpy || 0) > 0).length / Math.max(1, list.length);
  const reliabilityByBin = bucket.map((b, i) => {
    if (!b.n) {
      return {
        bin: i,
        n: 0,
        avgRaw: Number(((i + 0.5) / bins).toFixed(4)),
        winRate: Number(globalWinRate.toFixed(4)),
        blend: 0
      };
    }
    const avgRaw = b.avgRaw / b.n;
    const wr = b.wins / b.n;
    const blend = b.n / (b.n + shrinkage);
    return {
      bin: i,
      n: b.n,
      avgRaw: Number(avgRaw.toFixed(4)),
      winRate: Number(wr.toFixed(4)),
      blend: Number(blend.toFixed(4))
    };
  });

  return {
    enabled: true,
    pending: false,
    ready: true,
    bins,
    shrinkage,
    sampleSize: list.length,
    globalWinRate: Number(globalWinRate.toFixed(4)),
    reliabilityByBin
  };
}

export function calibrateConfidence(rawConfidence, model) {
  const raw = clamp(Number(rawConfidence || 0), 0, 1);
  if (!model?.enabled || !model?.ready) return raw;
  const bins = Math.max(1, Number(model.bins || 1));
  const idx = Math.min(bins - 1, Math.max(0, Math.floor(raw * bins)));
  const info = Array.isArray(model.reliabilityByBin) ? model.reliabilityByBin[idx] : null;
  if (!info || !Number.isFinite(Number(info.winRate))) return raw;
  const blend = clamp(Number(info.blend || 0), 0, 1);
  return Number((raw * (1 - blend) + Number(info.winRate || raw) * blend).toFixed(6));
}

export function calibrateSignalConfidence(signal, model) {
  if (!signal) return signal;
  const raw = clamp(Number(signal.confidence || 0), 0, 1);
  const calibrated = calibrateConfidence(raw, model);
  return {
    ...signal,
    confidence: calibrated,
    confidenceRaw: raw,
    confidenceCalibrated: calibrated
  };
}

function disabled(reason) {
  return {
    enabled: false,
    pending: false,
    ready: false,
    bins: 0,
    shrinkage: 0,
    sampleSize: 0,
    globalWinRate: 0.5,
    reliabilityByBin: [],
    reason
  };
}

