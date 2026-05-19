function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeRiskPips(signal, pipSize) {
  const entry = toNumber(signal?.entryPrice, 0);
  const stop = toNumber(signal?.stopLossPrice, 0);
  if (!(entry > 0) || !(stop > 0) || !(pipSize > 0)) return 0;
  return Math.abs(entry - stop) / pipSize;
}

export function planAutoHold({ baseSec, maxHoldSec, signal, ticker, pipSize = 0.01 }) {
  const normalizedBaseSec = clamp(toNumber(baseSec, 120), 5, 3600);
  const normalizedMaxHoldSec = clamp(toNumber(maxHoldSec, normalizedBaseSec), 5, 3600);
  const metrics = signal?.metrics || {};
  const ev = toNumber(metrics.expectedValuePips, 0);
  const rr = toNumber(metrics.rr, 1);
  const confidence = clamp(toNumber(signal?.confidence, 0.3), 0, 1);
  const spreadPips = Math.max(0, toNumber(metrics.spreadPips, toNumber(ticker?.spreadPips, 0.18)));
  const eventRisk = clamp(toNumber(signal?.news?.shortTermRiskLevel, 0), 0, 1);
  const riskPips = computeRiskPips(signal, pipSize);

  const evNorm = clamp((ev - 0.15) / 0.9, -1.2, 1.8);
  const rrNorm = clamp((rr - 1.2) / 0.8, -1.0, 1.6);
  const confidenceNorm = clamp((confidence - 0.52) / 0.28, -1.2, 1.6);
  const spreadPenalty = clamp((spreadPips - 0.2) / 0.35, 0, 1.8);
  const stopRiskPenalty = clamp((riskPips - 1.4) / 1.8, 0, 1.8);
  const lowConfidencePenalty = clamp((0.58 - confidence) / 0.4, 0, 1.4);

  const qualityScore = clamp(
    evNorm * 0.45 + rrNorm * 0.25 + confidenceNorm * 0.3 - spreadPenalty * 0.25,
    -1.8,
    2.2
  );
  const riskScore = clamp(
    spreadPenalty * 0.35 + stopRiskPenalty * 0.35 + lowConfidencePenalty * 0.3,
    0,
    2.0
  ) + eventRisk * 0.4;

  const dynamicTargetSec = clamp(
    45 + ev * 90 + (rr - 1) * 55 + confidence * 50 - spreadPenalty * 40 - riskScore * 60 - eventRisk * 45,
    8,
    normalizedMaxHoldSec
  );
  const holdMultiplier = clamp(1 + qualityScore * 0.42 - riskScore * 0.5, 0.25, 2.4);
  const holdSec = Number(clamp(normalizedBaseSec * 0.35 + dynamicTargetSec * 0.65, 8, normalizedMaxHoldSec).toFixed(3));
  const riskCutPips = Number(Math.max(0.45, riskPips * (0.3 + riskScore * 0.3)).toFixed(3));

  return {
    holdSec,
    holdMultiplier: Number(holdMultiplier.toFixed(4)),
    qualityScore: Number(qualityScore.toFixed(4)),
    riskScore: Number(riskScore.toFixed(4)),
    riskCutPips,
    riskPips: Number(riskPips.toFixed(3))
  };
}

export function unrealizedPips(position, exitPrice, pipSize = 0.01) {
  if (!(pipSize > 0)) return 0;
  const entry = toNumber(position?.entryPrice, 0);
  if (!(entry > 0)) return 0;
  const side = position?.side;
  if (side === "LONG") return (toNumber(exitPrice, entry) - entry) / pipSize;
  if (side === "SHORT") return (entry - toNumber(exitPrice, entry)) / pipSize;
  return 0;
}

export function shouldRiskCutPosition(position, exitPrice, nowMs, pipSize = 0.01) {
  const riskScore = toNumber(position?.riskScore, 0);
  if (riskScore < 0.55) return false;

  const openedAtMs = new Date(position?.openedAt || 0).getTime();
  if (!Number.isFinite(openedAtMs)) return false;
  const elapsedSec = Math.max(0, (nowMs - openedAtMs) / 1000);
  if (elapsedSec < 5) return false;

  const cutPips = Math.max(0.5, toNumber(position?.riskCutPips, 0.8));
  const pnlPips = unrealizedPips(position, exitPrice, pipSize);
  return pnlPips <= -cutPips;
}

export function evaluateStopRequestExit(position, exitPrice, nowMs, pipSize = 0.01, options = {}) {
  const stopRequested = Boolean(options?.stopRequested);
  const openedAtMs = new Date(position?.openedAt || 0).getTime();
  if (!Number.isFinite(openedAtMs)) {
    return {
      shouldClose: false,
      reason: null,
      pnlPips: 0,
      peakPnlPips: 0,
      peakAt: null
    };
  }

  const pnlPips = unrealizedPips(position, exitPrice, pipSize);
  const prevPeak = toNumber(position?.peakPnlPips, pnlPips);
  const peakPnlPips = Math.max(prevPeak, pnlPips);
  const peakAt = peakPnlPips > prevPeak ? new Date(nowMs).toISOString() : (position?.peakAt || null);

  const elapsedSec = Math.max(0, (nowMs - openedAtMs) / 1000);
  const plannedHoldSec = Math.max(8, toNumber(position?.plannedHoldSec, 45));
  const maxHoldSec = Math.max(plannedHoldSec, toNumber(position?.maxHoldSec, plannedHoldSec));
  const riskCutPips = Math.max(0.5, toNumber(position?.riskCutPips, 0.8));
  const riskScoreBase = clamp(toNumber(position?.riskScore, 0), 0, 2);
  const eventRisk = clamp(
    toNumber(position?.signalNews?.shortTermRiskLevel, 0)
      + toNumber(options?.eventRiskLevel, 0) * 0.3,
    0,
    1.5
  );
  const spreadStress = clamp((toNumber(options?.spreadPips, toNumber(position?.signalMetrics?.spreadPips, 0.18)) - 0.2) / 0.35, 0, 1.6);
  const elapsedRatio = clamp(elapsedSec / Math.max(8, plannedHoldSec), 0, 2);
  const riskScore = clamp(riskScoreBase + eventRisk * 0.45 + spreadStress * 0.2 + Math.max(0, elapsedRatio - 1) * 0.22, 0, 2.4);
  const qualityScore = toNumber(position?.qualityScore, 0);
  const targetPips = Math.max(0.8, riskCutPips * (1.35 - eventRisk * 0.2));
  const retracePips = Math.max(0.35, targetPips * (0.32 - eventRisk * 0.06));
  const peakRetracePips = Math.max(0, peakPnlPips - pnlPips);
  const suspiciousElapsedSec = Math.min(60, Math.max(10, plannedHoldSec * (0.45 - eventRisk * 0.12)));

  if (elapsedSec < 6) {
    return { shouldClose: false, reason: null, pnlPips, peakPnlPips, peakAt };
  }

  // P9/P10: compress bad entries before the full SL is hit. This targets TREND_UP late entries
  // and other no-follow-through trades without changing the primary signal engine.
  if (!stopRequested && elapsedSec <= 30 && peakPnlPips < 0.2 && pnlPips <= -0.6) {
    return { shouldClose: true, reason: "quick-adverse-move-exit", pnlPips, peakPnlPips, peakAt };
  }
  if (!stopRequested && elapsedSec <= 60 && peakPnlPips < 0.3 && pnlPips <= -0.8) {
    return { shouldClose: true, reason: "no-follow-through-exit", pnlPips, peakPnlPips, peakAt };
  }
  if (!stopRequested && elapsedSec <= 120 && peakPnlPips < 0.5 && pnlPips <= -1.0) {
    return { shouldClose: true, reason: "failed-entry-timing-exit", pnlPips, peakPnlPips, peakAt };
  }
  if (!stopRequested && elapsedSec >= 60 && peakPnlPips < 0.3 && pnlPips <= -0.8) {
    return { shouldClose: true, reason: "bad-entry-location-exit", pnlPips, peakPnlPips, peakAt };
  }

  // P8: once MFE appears, do not let "peak take" become a negative close.
  if (!stopRequested && peakPnlPips >= 1.0 && pnlPips <= 0.2) {
    return { shouldClose: true, reason: "fast-peak-protect-exit", pnlPips, peakPnlPips, peakAt, minExitPipsAfterPeak: 0.2 };
  }
  if (!stopRequested && peakPnlPips >= 0.8 && pnlPips <= 0) {
    return { shouldClose: true, reason: "fast-peak-protect-exit", pnlPips, peakPnlPips, peakAt, minExitPipsAfterPeak: 0 };
  }
  if (!stopRequested && peakPnlPips >= 0.6 && pnlPips < 0) {
    return {
      shouldClose: true,
      reason: "trend-up-giveback-protect-exit",
      pnlPips,
      peakPnlPips,
      peakAt,
      autoPeakTakeNegativePrevented: true
    };
  }

  // 常時監視: 高リスク化して損失が深くなる前にカット
  if (!stopRequested && riskScore >= 0.65 && pnlPips <= -Math.max(0.45, riskCutPips * 0.7)) {
    return { shouldClose: true, reason: "auto-risk-guard", pnlPips, peakPnlPips, peakAt };
  }
  // 常時監視: いったん十分伸びた後の失速をピーク利確
  if (!stopRequested && peakPnlPips >= targetPips && peakRetracePips >= retracePips && pnlPips > 0) {
    return { shouldClose: true, reason: "auto-peak-take", pnlPips, peakPnlPips, peakAt };
  }
  // 常時監視: 低品質局面で伸び悩み/失速したら早期利確
  if (!stopRequested && elapsedSec >= suspiciousElapsedSec && qualityScore <= 0 && peakPnlPips >= 0.8 && pnlPips > 0 && peakRetracePips >= 0.25) {
    return { shouldClose: true, reason: "auto-suspicious-take", pnlPips, peakPnlPips, peakAt };
  }

  if (stopRequested) {
    if (pnlPips <= -Math.max(0.5, riskCutPips * 0.9)) {
      return { shouldClose: true, reason: "auto-stop-risk", pnlPips, peakPnlPips, peakAt };
    }
    if (peakPnlPips >= targetPips && (peakPnlPips - pnlPips) >= retracePips) {
      return { shouldClose: true, reason: "auto-stop-trailing", pnlPips, peakPnlPips, peakAt };
    }
    if (elapsedSec >= plannedHoldSec && pnlPips > 0) {
      return { shouldClose: true, reason: "auto-stop-window", pnlPips, peakPnlPips, peakAt };
    }
    if (elapsedSec >= maxHoldSec && pnlPips >= 0) {
      return { shouldClose: true, reason: "auto-stop-timeout", pnlPips, peakPnlPips, peakAt };
    }
  }
  return { shouldClose: false, reason: null, pnlPips, peakPnlPips, peakAt };
}

export function computePartialExitPlan({
  pnlPips,
  riskPips,
  qty,
  cfg = {},
  degraded = false,
  minOrderQty = 1,
  minRemainingQty = 1
}) {
  const firstTakeR = Math.max(0.5, Number(degraded ? (cfg.degradedFirstTakeR || 0.8) : (cfg.firstTakeR || 1)));
  const firstTakePortion = clamp(Number(degraded ? (cfg.degradedFirstTakePortion || 0.6) : (cfg.firstTakePortion || 0.5)), 0.1, 0.9);
  const baseRiskPips = Math.max(0.5, Number(riskPips || 1));
  const triggerPips = baseRiskPips * firstTakeR;
  const q = Math.max(0, Number(qty || 0));
  if (!(q > minOrderQty + minRemainingQty)) {
    return { shouldPartial: false, closeQty: 0, remainingQty: q, triggerPips, firstTakeR, firstTakePortion };
  }
  if (Number(pnlPips || 0) < triggerPips) {
    return { shouldPartial: false, closeQty: 0, remainingQty: q, triggerPips, firstTakeR, firstTakePortion };
  }
  let closeQty = Number((q * firstTakePortion).toFixed(3));
  closeQty = Math.max(minOrderQty, closeQty);
  closeQty = Math.min(closeQty, Math.max(minOrderQty, q - minRemainingQty));
  const remainingQty = Number((q - closeQty).toFixed(3));
  if (remainingQty < minRemainingQty || closeQty < minOrderQty) {
    return { shouldPartial: false, closeQty: 0, remainingQty: q, triggerPips, firstTakeR, firstTakePortion };
  }
  return { shouldPartial: true, closeQty, remainingQty, triggerPips, firstTakeR, firstTakePortion };
}

export function computeAtrTrailingStop({
  side,
  exitPrice,
  currentStopLoss,
  atrValue,
  atrMultiplier = 2.4,
  pipSize = 0.01
}) {
  const dist = Math.max(pipSize * 2, Number(atrValue || 0) * clamp(Number(atrMultiplier || 2.4), 1.2, 5));
  const trailStop = side === "BUY"
    ? Number((Number(exitPrice || 0) - dist).toFixed(6))
    : Number((Number(exitPrice || 0) + dist).toFixed(6));
  const cur = Number(currentStopLoss || trailStop);
  const next = side === "BUY" ? Math.max(cur, trailStop) : Math.min(cur, trailStop);
  return Number(next.toFixed(6));
}
