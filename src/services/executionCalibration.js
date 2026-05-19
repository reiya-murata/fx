import { analyticsSummary } from "./analytics.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function computeExecutionCalibration(trades, cfg = {}) {
  if (!Boolean(cfg.enabled)) {
    return { enabled: false, ready: false, rejectRateAdj: 0, slippageAdj: 1, latencyAdj: 1 };
  }
  const stateLike = normalizeStateLike(trades);
  const list = (Array.isArray(stateLike.trades) ? [...stateLike.trades] : [])
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0))
    .slice(-Math.max(30, Number(cfg.lookbackTrades || 200)));
  const minTrades = Math.max(10, Number(cfg.minTrades || 30));
  if (list.length < minTrades) {
    return {
      enabled: true,
      ready: false,
      reason: `calibration pending: ${list.length}/${minTrades}`,
      rejectRateAdj: 0,
      slippageAdj: 1,
      latencyAdj: 1
    };
  }

  const rejects = estimateRejectCount(stateLike, list.length);
  const rejectRate = rejects / Math.max(1, list.length + rejects);
  const avgSlip = list.reduce((s, t) => s + Math.abs(Number(t.slippagePips || 0)), 0) / Math.max(1, list.length);
  const avgLatency = list.reduce((s, t) => s + Number(t.latencyMs || 0), 0) / Math.max(1, list.length);
  const targetRejectRate = Number(cfg.targetRejectRate || 0.025);
  const targetSlippage = Number(cfg.targetSlippagePips || 0.28);
  const targetLatency = Number(cfg.targetLatencyMs || 280);
  const summary = analyticsSummary(list);
  const lossPressure = clamp(-Number(summary.netProfitJpy || 0) / 150000, 0, 1.5);
  return {
    enabled: true,
    ready: true,
    sampleSize: list.length,
    rejectRateAdj: Number(clamp((rejectRate - targetRejectRate) * 0.55 + lossPressure * 0.01, -0.03, 0.06).toFixed(4)),
    slippageAdj: Number(clamp(1 + (avgSlip - targetSlippage) * 0.55 + lossPressure * 0.04, 0.8, 1.5).toFixed(4)),
    latencyAdj: Number(clamp(1 + (avgLatency - targetLatency) / 1400 + lossPressure * 0.04, 0.85, 1.35).toFixed(4)),
    stats: {
      rejectRate: Number(rejectRate.toFixed(4)),
      avgSlippagePips: Number(avgSlip.toFixed(4)),
      avgLatencyMs: Number(avgLatency.toFixed(2))
    }
  };
}

export function computeExecutionCalibrationFromTelemetry(records, cfg = {}) {
  if (!Boolean(cfg.enabled)) {
    return { enabled: false, ready: false, rejectRateAdj: 0, slippageAdj: 1, latencyAdj: 1 };
  }
  const lookback = Math.max(50, Number(cfg.telemetryLookbackRecords || 5000));
  const minRecords = Math.max(20, Number(cfg.telemetryMinRecords || 150));
  const list = (Array.isArray(records) ? [...records] : [])
    .sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0))
    .slice(-lookback);
  if (list.length < minRecords) {
    return {
      enabled: true,
      ready: false,
      reason: `telemetry calibration pending: ${list.length}/${minRecords}`,
      rejectRateAdj: 0,
      slippageAdj: 1,
      latencyAdj: 1
    };
  }
  const rejects = list.filter((r) => Boolean(r.rejected)).length;
  const rejectRate = rejects / Math.max(1, list.length);
  const avgSlip = list.reduce((s, r) => s + Math.abs(Number(r.slippagePips || 0)), 0) / Math.max(1, list.length);
  const avgLatency = list.reduce((s, r) => {
    const brokerLatency = Math.max(0, Number(r.latencyMs || 0));
    const decisionLatency = Math.max(0, Number(r.decisionLatencyMs || 0));
    const combined = brokerLatency + decisionLatency;
    return s + combined;
  }, 0) / Math.max(1, list.length);
  const targetRejectRate = Number(cfg.targetRejectRate || 0.025);
  const targetSlippage = Number(cfg.targetSlippagePips || 0.28);
  const targetLatency = Number(cfg.targetLatencyMs || 280);
  const rejectRateAdj = Number(clamp((rejectRate - targetRejectRate) * 0.7, -0.04, 0.08).toFixed(4));
  const slippageAdj = Number(clamp(1 + (avgSlip - targetSlippage) * 0.7, 0.75, 1.7).toFixed(4));
  const latencyAdj = Number(clamp(1 + (avgLatency - targetLatency) / 1200, 0.8, 1.45).toFixed(4));
  return {
    enabled: true,
    ready: true,
    source: "execution-telemetry",
    sampleSize: list.length,
    rejectRateAdj,
    slippageAdj,
    latencyAdj,
    stats: {
      rejectRate: Number(rejectRate.toFixed(4)),
      avgSlippagePips: Number(avgSlip.toFixed(4)),
      avgLatencyMs: Number(avgLatency.toFixed(2))
    }
  };
}

function normalizeStateLike(input) {
  if (Array.isArray(input)) {
    return { trades: input, orders: [], auditLogs: [] };
  }
  if (input && typeof input === "object") {
    return {
      trades: Array.isArray(input.trades) ? input.trades : [],
      orders: Array.isArray(input.orders) ? input.orders : [],
      auditLogs: Array.isArray(input.auditLogs) ? input.auditLogs : []
    };
  }
  return { trades: [], orders: [], auditLogs: [] };
}

function estimateRejectCount(stateLike, lookbackTrades) {
  const orders = stateLike.orders || [];
  const fromOrders = orders
    .slice(-Math.max(20, lookbackTrades * 2))
    .filter((o) => String(o?.status || "").toUpperCase().includes("REJECT"))
    .length;
  const logs = stateLike.auditLogs || [];
  const fromAudit = logs
    .slice(-Math.max(50, lookbackTrades * 3))
    .filter((a) => a?.event === "auto.order.rejected")
    .length;
  return Math.max(fromOrders, fromAudit, 0);
}
