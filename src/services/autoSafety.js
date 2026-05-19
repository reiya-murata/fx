import { analyticsSummary } from "./analytics.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortedAutoTrades(trades) {
  return (Array.isArray(trades) ? trades : [])
    .filter((t) => {
      if (t?.entryPrice !== undefined && !(Number(t.entryPrice) > 0)) return false;
      if (t?.exitPrice !== undefined && !(Number(t.exitPrice) > 0)) return false;
      if (t?.qty !== undefined && !(Number(t.qty) > 0)) return false;
      return true;
    })
    .filter((t) => String(t?.exitReason || "").startsWith("auto-"))
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
}

function countTrailingLosses(trades) {
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    if (Number(trades[i]?.netPnlJpy || 0) < 0) count += 1;
    else break;
  }
  return count;
}

export function evaluateKillSwitch({ state, cfg = {} }) {
  if (!cfg?.enabled) {
    return { enabled: false, shouldStop: false, reason: "kill switch disabled" };
  }
  const initial = Math.max(1, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const current = Math.max(0, Number(state?.account?.currentBalanceJpy || initial));
  const ddRatio = current < initial ? (initial - current) / initial : 0;
  const ddThrottle = clamp(Number(cfg.ddThrottlePercent || 0.06), 0.005, 0.5);
  const ddStop = clamp(Number(cfg.ddStopPercent || 0.08), Math.max(ddThrottle, 0.005), 0.5);
  const trailingLosses = countTrailingLosses(sortedAutoTrades(state?.trades || []));
  const lossThrottle = Math.max(2, Number(cfg.consecutiveLossThrottle || 8));
  const lossStop = Math.max(lossThrottle, Number(cfg.consecutiveLossStop || 14));
  const throttleRiskMultiplier = clamp(Number(cfg.throttleRiskMultiplier || 0.5), 0.05, 1);

  if (ddRatio >= ddStop) {
    return {
      enabled: true,
      shouldStop: true,
      shouldThrottle: true,
      riskMultiplier: throttleRiskMultiplier,
      ddRatio: Number(ddRatio.toFixed(6)),
      trailingLosses,
      reason: `kill switch: drawdown ${(ddRatio * 100).toFixed(2)}% >= ${(ddStop * 100).toFixed(2)}%`
    };
  }
  if (trailingLosses >= lossStop) {
    return {
      enabled: true,
      shouldStop: true,
      shouldThrottle: true,
      riskMultiplier: throttleRiskMultiplier,
      ddRatio: Number(ddRatio.toFixed(6)),
      trailingLosses,
      reason: `kill switch: trailing losses ${trailingLosses} >= ${lossStop}`
    };
  }
  const shouldThrottle = ddRatio >= ddThrottle || trailingLosses >= lossThrottle;
  return {
    enabled: true,
    shouldStop: false,
    shouldThrottle,
    riskMultiplier: shouldThrottle ? throttleRiskMultiplier : 1,
    ddRatio: Number(ddRatio.toFixed(6)),
    trailingLosses,
    reason: shouldThrottle
      ? `kill switch throttle: dd=${(ddRatio * 100).toFixed(2)}%, losses=${trailingLosses}`
      : "kill switch normal"
  };
}

export function evaluateRollingExpectancy({ trades, memory = null, cfg = {} }) {
  if (!cfg?.enabled) {
    return { enabled: false, shouldStop: false, reason: "rolling expectancy disabled" };
  }
  const lookback = Math.max(10, Number(cfg.lookbackTrades || 30));
  const minTrades = Math.max(5, Number(cfg.minTrades || 25));
  const warnExpectancyR = Number(cfg.warningExpectancyR || -0.01);
  const warnPf = Number(cfg.warningProfitFactor || 1.03);
  const stopExpectancyR = Number(cfg.stopExpectancyR || -0.02);
  const stopPf = Number(cfg.stopProfitFactor || 1.0);
  const rescueExpectancyR = Number(cfg.rescueExpectancyR || -0.015);
  const rescuePf = Number(cfg.rescueProfitFactor || 1.01);
  const rescueRiskMultiplier = clamp(Number(cfg.rescueRiskMultiplier || 0.15), 0.03, 1);
  const rescueCooldownSec = Math.max(0, Number(cfg.rescueCooldownSec || 1800));
  const throttleRiskMultiplier = clamp(Number(cfg.throttleRiskMultiplier || 0.25), 0.05, 1);
  const extremeRiskMultiplier = clamp(Number(cfg.extremeRiskMultiplier || 0.1), 0.02, throttleRiskMultiplier);
  const stopConsecutiveBreakdown = Math.max(2, Number(cfg.stopConsecutiveBreakdown || 3));
  const startupNoRescueTrades = Math.max(0, Number(cfg.startupNoRescueTrades || 0));
  const list = sortedAutoTrades(trades).slice(-lookback);
  const totalTrades = sortedAutoTrades(trades).length;

  if (list.length >= minTrades) {
    const recent = list.slice(-lookback);
    const full = sortedAutoTrades(trades);
    const prev = full.slice(-(lookback * 2), -lookback);
    const prev2 = full.slice(-(lookback * 3), -(lookback * 2));
    const sRecent = analyticsSummary(recent);
    const recentExpectancyJpy = sRecent.totalTrades > 0
      ? Number((sRecent.netProfitJpy / sRecent.totalTrades).toFixed(2))
      : 0;
    const recentPf = Number(sRecent.profitFactor || 0);
    const recentExpectancyR = expectancyInR(recent);
    const recentWarn = recentPf < warnPf && recentExpectancyR < warnExpectancyR;
    const recentRescue = recentPf < rescuePf && recentExpectancyR < rescueExpectancyR;
    const recentStop = recentPf < stopPf && recentExpectancyR < stopExpectancyR;
    let prevFail = false;
    let prev2Fail = false;
    let prevExpectancyJpy = null;
    let prevExpectancyR = null;
    let prevPf = null;
    if (prev.length >= minTrades) {
      const sPrev = analyticsSummary(prev);
      prevExpectancyJpy = sPrev.totalTrades > 0
        ? Number((sPrev.netProfitJpy / sPrev.totalTrades).toFixed(2))
        : 0;
      prevExpectancyR = expectancyInR(prev);
      prevPf = Number(sPrev.profitFactor || 0);
      prevFail = prevPf < stopPf && prevExpectancyR < stopExpectancyR;
    }
    if (prev2.length >= minTrades) {
      const sPrev2 = analyticsSummary(prev2);
      const prev2ExpectancyR = expectancyInR(prev2);
      const prev2Pf = Number(sPrev2.profitFactor || 0);
      prev2Fail = prev2Pf < stopPf && prev2ExpectancyR < stopExpectancyR;
    }
    const consecutiveBreakdown = recentStop
      ? (prevFail ? (prev2Fail ? 3 : 2) : 1)
      : (recentWarn ? 1 : 0);
    const shouldStop = consecutiveBreakdown >= stopConsecutiveBreakdown;
    const startupRescueSuppressed = startupNoRescueTrades > 0 && totalTrades < startupNoRescueTrades;
    const shouldRescue = !shouldStop && recentRescue && !startupRescueSuppressed;
    const shouldThrottle = !shouldStop && !shouldRescue && consecutiveBreakdown >= 1;
    const riskMultiplier = shouldStop
      ? extremeRiskMultiplier
      : (shouldRescue
        ? rescueRiskMultiplier
        : (consecutiveBreakdown >= 2 ? extremeRiskMultiplier : (shouldThrottle ? throttleRiskMultiplier : 1)));
    const reason = shouldStop
      ? `rolling expectancy breakdown x${consecutiveBreakdown}: expR=${recentExpectancyR.toFixed(4)}, pf=${recentPf.toFixed(3)}`
      : (shouldRescue
        ? `rolling expectancy rescue: expR=${recentExpectancyR.toFixed(4)}, pf=${recentPf.toFixed(3)}`
        : (startupRescueSuppressed && recentRescue
          ? `rolling expectancy rescue suppressed(startup): ${totalTrades}/${startupNoRescueTrades}`
        : (consecutiveBreakdown >= 2
        ? `rolling expectancy severe throttle x${consecutiveBreakdown}: expR=${recentExpectancyR.toFixed(4)}, pf=${recentPf.toFixed(3)}`
        : (shouldThrottle
          ? `rolling expectancy warning x1: expR=${recentExpectancyR.toFixed(4)}, pf=${recentPf.toFixed(3)}`
          : "rolling expectancy normal"))));
    return {
      enabled: true,
      shouldStop,
      shouldThrottle,
      shouldRescue,
      rescueCooldownSec,
      riskMultiplier,
      pending: false,
      sampleSize: list.length,
      expectancyJpy: recentExpectancyJpy,
      expectancyR: Number(recentExpectancyR.toFixed(6)),
      profitFactor: recentPf,
      previousExpectancyJpy: prevExpectancyJpy,
      previousExpectancyR: prevExpectancyR,
      previousProfitFactor: prevPf,
      consecutiveBreakdown,
      reason
    };
  }

  const memTrades = Number(memory?.totalTrades || 0);
  if (memTrades >= minTrades) {
    const expJpy = Number(memory?.ewmaExpectancyJpy || 0);
    const pf = Number(memory?.ewmaProfitFactor || 1);
    const expR = Number(memory?.ewmaExpectancyR || 0);
    const shouldThrottle = expR < warnExpectancyR && pf < warnPf;
    return {
      enabled: true,
      shouldStop: false,
      shouldThrottle,
      riskMultiplier: shouldThrottle ? throttleRiskMultiplier : 1,
      pending: false,
      source: "learning-memory",
      sampleSize: list.length,
      memorySampleSize: memTrades,
      expectancyJpy: expJpy,
      expectancyR: expR,
      profitFactor: pf,
      consecutiveBreakdown: shouldThrottle ? 1 : 0,
      shouldRescue: false,
      rescueCooldownSec,
      reason: shouldThrottle
        ? `rolling expectancy warning(memory): expR=${expR.toFixed(4)}, pf=${pf.toFixed(3)}`
        : "rolling expectancy normal(memory)"
    };
  }

  return {
    enabled: true,
    shouldStop: false,
    shouldThrottle: false,
    riskMultiplier: 1,
    pending: true,
    shouldRescue: false,
    rescueCooldownSec,
    sampleSize: list.length,
    reason: `rolling expectancy pending: ${list.length}/${minTrades}`
  };
}

function expectancyInR(trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) return 0;
  const wins = list.filter((t) => Number(t?.netPnlJpy || 0) > 0).map((t) => Number(t.netPnlJpy || 0));
  const losses = list.filter((t) => Number(t?.netPnlJpy || 0) < 0).map((t) => Math.abs(Number(t.netPnlJpy || 0)));
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 1;
  if (!(avgLoss > 0)) return 0;
  const winR = wins.length ? (wins.reduce((s, v) => s + v, 0) / wins.length) / avgLoss : 0;
  const lossR = losses.length ? (losses.reduce((s, v) => s + v, 0) / losses.length) / avgLoss : 1;
  const p = wins.length / list.length;
  return p * winR - (1 - p) * lossR;
}

function minutesJst(isoTs) {
  const t = new Date(isoTs || Date.now()).getTime();
  const j = new Date(t + 9 * 60 * 60 * 1000);
  return j.getUTCHours() * 60 + j.getUTCMinutes();
}

function parseWindowRange(text) {
  const m = String(text || "").match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to };
}

function inWindow(minute, range) {
  if (!range) return false;
  if (range.from === range.to) return true;
  if (range.from < range.to) return minute >= range.from && minute < range.to;
  return minute >= range.from || minute < range.to;
}

export function evaluateNoTradeZoneSchedule(ts, cfg = {}) {
  if (!cfg?.enabled) return { enabled: false, blocked: false, sizeMultiplier: 1, reasonCode: "DISABLED", reason: "no-trade zone disabled" };
  const nowMin = minutesJst(ts);
  const hard = (Array.isArray(cfg.hardBlockWindowsJst) ? cfg.hardBlockWindowsJst : [])
    .map(parseWindowRange)
    .filter(Boolean);
  const down = (Array.isArray(cfg.sizeDownWindowsJst) ? cfg.sizeDownWindowsJst : [])
    .map(parseWindowRange)
    .filter(Boolean);
  const hardHit = hard.some((r) => inWindow(nowMin, r));
  if (hardHit) {
    return {
      enabled: true,
      blocked: true,
      sizeMultiplier: 0,
      reasonCode: "SCHEDULE_HARD_BLOCK",
      reason: "no-trade zone: hard block window"
    };
  }
  const downHit = down.some((r) => inWindow(nowMin, r));
  if (downHit) {
    return {
      enabled: true,
      blocked: false,
      sizeMultiplier: clamp(Number(cfg.sizeDownMultiplier || 0.5), 0.1, 1),
      reasonCode: "SCHEDULE_SIZE_DOWN",
      reason: "no-trade zone: size-down window"
    };
  }
  return { enabled: true, blocked: false, sizeMultiplier: 1, reasonCode: "NORMAL", reason: "no-trade zone normal" };
}

export function computeExecutionQualityScore({
  p95PipelineLatencyMs = 0,
  p95SlippagePips = 0,
  rejectRate = 0,
  targetSlippagePips = 0.28,
  p95LatencyRefMs = 700,
  rejectRateRef = 0.04
} = {}) {
  const latPenalty = clamp((Number(p95PipelineLatencyMs || 0) - Number(p95LatencyRefMs || 700)) / 400, 0, 1);
  const slipRatio = Number(targetSlippagePips || 0.28) > 0 ? Number(p95SlippagePips || 0) / Number(targetSlippagePips || 0.28) : 1;
  const slipPenalty = clamp((slipRatio - 1) / 1, 0, 1);
  const rejPenalty = clamp((Number(rejectRate || 0) - Number(rejectRateRef || 0.04)) / 0.08, 0, 1);
  const score = clamp(1 - latPenalty * 0.4 - slipPenalty * 0.35 - rejPenalty * 0.25, 0.3, 1.2);
  return Number(score.toFixed(4));
}

export function computeEdgeSizingMultiplier({
  regimeConfidence = 1,
  ensembleAgreement = 1,
  executionQualityScore = 1,
  microEdge = 0,
  nearTailThreshold = false,
  minMultiplier = 0.5,
  maxMultiplier = 2
} = {}) {
  const baseScore = Number(regimeConfidence || 0) * Number(ensembleAgreement || 0) * Number(executionQualityScore || 0);
  const microAdj = 1 + clamp(Number(microEdge || 0), -1, 1) * 0.15;
  const edgeScoreRaw = baseScore * microAdj;
  const edgeScore = Number(clamp(edgeScoreRaw, 0.5, 2).toFixed(4));
  let sizingMultiplier = edgeScore;
  if (Boolean(nearTailThreshold)) sizingMultiplier = Math.min(1, sizingMultiplier);
  sizingMultiplier = Number(clamp(sizingMultiplier, Number(minMultiplier || 0.5), Number(maxMultiplier || 2)).toFixed(4));
  return { edgeScore, sizingMultiplier };
}

// P1: broker-aware latency sizing to preserve expectancy under slow execution.
export function computeLatencySizingMultiplier({
  p95PipelineLatencyMs = 0,
  latencyRefMs = 700,
  latencySoftCapMs = 1000,
  minMultiplier = 0.55
} = {}) {
  const p95 = Number(p95PipelineLatencyMs || 0);
  const ref = Math.max(100, Number(latencyRefMs || 700));
  const cap = Math.max(ref + 50, Number(latencySoftCapMs || 1000));
  const minM = clamp(Number(minMultiplier || 0.55), 0.1, 1);
  if (p95 <= ref) return 1;
  if (p95 >= cap) return Number(minM.toFixed(4));
  const t = (p95 - ref) / (cap - ref);
  return Number((1 - t * (1 - minM)).toFixed(4));
}

function linearPenalty(value, start, end, minMultiplier) {
  const v = Number(value || 0);
  const s = Number(start || 0);
  const e = Number(end || 0);
  const minM = clamp(Number(minMultiplier || 0.5), 0.05, 1);
  if (!(e > s)) return 1;
  if (v <= s) return 1;
  if (v >= e) return minM;
  const t = (v - s) / (e - s);
  return Number((1 - t * (1 - minM)).toFixed(4));
}

// P0: unified tail penalty replaces overlapping tail-aware scalers.
export function computeTailPenaltyMultiplier({
  p95PipelineLatencyMs = 0,
  p99PipelineLatencyMs = 0,
  rejectRate = 0,
  p95SlippagePips = 0,
  targetSlippagePips = 0.28,
  cfg = {}
} = {}) {
  const p95Lat = Number(p95PipelineLatencyMs || 0);
  const p99Lat = Number(p99PipelineLatencyMs || 0);
  const rej = Number(rejectRate || 0);
  const p95Slip = Number(p95SlippagePips || 0);
  const targetSlip = Math.max(0.01, Number(targetSlippagePips || 0.28));
  const latMul = linearPenalty(
    p95Lat,
    Number(cfg.p95LatencyStartMs || 700),
    Number(cfg.p95LatencyEndMs || 1000),
    Number(cfg.p95LatencyMinMultiplier || 0.5)
  );
  const p99Mul = linearPenalty(
    p99Lat,
    Number(cfg.p99LatencyStartMs || 1100),
    Number(cfg.p99LatencyEndMs || 1400),
    Number(cfg.p99LatencyMinMultiplier || 0.6)
  );
  const slipMul = linearPenalty(
    p95Slip,
    targetSlip * Number(cfg.slippageStartMultiplier || 1.5),
    targetSlip * Number(cfg.slippageEndMultiplier || 2.5),
    Number(cfg.slippageMinMultiplier || 0.5)
  );
  const rejectMul = linearPenalty(
    rej,
    Number(cfg.rejectRateStart || 0.05),
    Number(cfg.rejectRateEnd || 0.12),
    Number(cfg.rejectRateMinMultiplier || 0.4)
  );
  return Number(clamp(
    Math.min(latMul, p99Mul, slipMul, rejectMul),
    Number(cfg.minMultiplier || 0.35),
    Number(cfg.maxMultiplier || 1)
  ).toFixed(4));
}

export function computeTailAwareSizeDown({
  p95PipelineLatencyMs = 0,
  p95SlippagePips = 0,
  targetSlippagePips = 0.28
} = {}) {
  return computeTailPenaltyMultiplier({
    p95PipelineLatencyMs,
    p95SlippagePips,
    targetSlippagePips,
    cfg: {
      p95LatencyStartMs: 700,
      p95LatencyEndMs: 900,
      p95LatencyMinMultiplier: 0.5,
      slippageStartMultiplier: 1.5,
      slippageEndMultiplier: 2,
      slippageMinMultiplier: 0.5,
      minMultiplier: 0.5,
      maxMultiplier: 1
    }
  });
}
