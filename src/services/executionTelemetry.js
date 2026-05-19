import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TELEMETRY_PATH = resolve(process.cwd(), "data/execution_telemetry.json");
const FLUSH_DEBOUNCE_MS = 250;
const FLUSH_BATCH_SIZE = 64;
let cacheItems = null;
let dirty = false;
let flushTimer = null;
let hooksRegistered = false;

function ensureFile() {
  if (existsSync(TELEMETRY_PATH)) return;
  mkdirSync(dirname(TELEMETRY_PATH), { recursive: true });
  writeFileSync(TELEMETRY_PATH, JSON.stringify({ items: [] }, null, 2));
}

function loadItems() {
  ensureFile();
  try {
    const raw = readFileSync(TELEMETRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function saveItems(items) {
  writeFileSync(TELEMETRY_PATH, JSON.stringify({ items }, null, 2));
}

function ensureLoaded() {
  if (!Array.isArray(cacheItems)) cacheItems = loadItems();
  if (!hooksRegistered) {
    hooksRegistered = true;
    process.on("beforeExit", () => flushNow());
    process.on("SIGINT", () => {
      flushNow();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      flushNow();
      process.exit(0);
    });
  }
}

function flushNow() {
  if (!dirty || !Array.isArray(cacheItems)) return;
  saveItems(cacheItems);
  dirty = false;
}

function scheduleFlush() {
  if (!dirty) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function percentile(values, p) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const idx = clamp(Math.floor((list.length - 1) * p), 0, list.length - 1);
  return list[idx];
}

export function appendExecutionTelemetry(item, maxItems = 30000) {
  ensureLoaded();
  const row = {
    ts: new Date().toISOString(),
    source: String(item?.source || "unknown"),
    session: String(item?.session || "UNKNOWN"),
    eventTag: String(item?.eventTag || "GENERAL"),
    spreadPips: Number(item?.spreadPips || 0),
    slippagePips: Number(item?.slippagePips || 0),
    latencyMs: Number(item?.latencyMs || 0),
    decisionLatencyMs: Number(item?.decisionLatencyMs || 0),
    totalPipelineLatencyMs: Number(item?.totalPipelineLatencyMs || 0),
    rejected: Boolean(item?.rejected),
    executedQty: Number(item?.executedQty || 0),
    requestedPrice: Number(item?.requestedPrice || 0),
    avgFillPrice: Number(item?.avgFillPrice || 0),
    rejectProbability: Number(item?.rejectProbability || 0),
    executionStress: Number(item?.executionStress || 0),
    tradeMode: String(item?.tradeMode || "BASE"),
    edgeScore: Number(item?.edgeScore || 1),
    sizingMultiplier: Number(item?.sizingMultiplier || 1),
    profile: String(item?.profile || "BASELINE"),
    processLatency: (item?.processLatency && typeof item.processLatency === "object")
      ? {
        totalMs: Number(item.processLatency.totalMs || 0),
        baseChecksMs: Number(item.processLatency.baseChecksMs || 0),
        decisionMs: Number(item.processLatency.decisionMs || 0),
        riskGateMs: Number(item.processLatency.riskGateMs || 0),
        executionSimMs: Number(item.processLatency.executionSimMs || 0)
      }
      : null
  };
  cacheItems = [...cacheItems, row].slice(-Math.max(1000, Number(maxItems || 30000)));
  dirty = true;
  if (cacheItems.length % FLUSH_BATCH_SIZE === 0) flushNow();
  else scheduleFlush();
  return row;
}

export function listExecutionTelemetry(limit = 200) {
  ensureLoaded();
  const safe = Math.max(1, Math.min(Number(limit || 200), 5000));
  return cacheItems.slice(-safe).reverse();
}

export function getExecutionTelemetryStats(options = {}) {
  ensureLoaded();
  const lookback = Math.max(100, Math.min(Number(options.lookback || 5000), 50000));
  const items = cacheItems.slice(-lookback);
  const n = items.length;
  const rejects = items.filter((x) => x.rejected).length;
  const slip = items.map((x) => Math.abs(Number(x.slippagePips || 0)));
  const lat = items.map((x) => Math.max(0, Number(x.latencyMs || 0)));
  const decisionLat = items.map((x) => Math.max(0, Number(x.decisionLatencyMs || 0)));
  const pipelineLat = items.map((x) => Math.max(0, Number(x.totalPipelineLatencyMs || 0)));
  const spreads = items.map((x) => Number(x.spreadPips || 0));
  const avgSpread = n ? (spreads.reduce((s, v) => s + v, 0) / n) : 0;
  const spreadVariance = n > 1
    ? spreads.reduce((s, v) => s + (v - avgSpread) ** 2, 0) / (n - 1)
    : 0;
  const edgeScores = items.map((x) => Number(x.edgeScore || 1)).filter(Number.isFinite);
  const sizingMultipliers = items.map((x) => Number(x.sizingMultiplier || 1)).filter(Number.isFinite);
  const bySession = {};
  const byTag = {};
  const byTradeMode = {};
  for (const x of items) {
    bySession[x.session] = bySession[x.session] || { count: 0, rejects: 0, slippage: 0, latency: 0 };
    bySession[x.session].count += 1;
    bySession[x.session].rejects += x.rejected ? 1 : 0;
    bySession[x.session].slippage += Math.abs(Number(x.slippagePips || 0));
    bySession[x.session].latency += Math.max(0, Number(x.latencyMs || 0));

    byTag[x.eventTag] = byTag[x.eventTag] || { count: 0, rejects: 0, slippage: 0, latency: 0 };
    byTag[x.eventTag].count += 1;
    byTag[x.eventTag].rejects += x.rejected ? 1 : 0;
    byTag[x.eventTag].slippage += Math.abs(Number(x.slippagePips || 0));
    byTag[x.eventTag].latency += Math.max(0, Number(x.latencyMs || 0));

    byTradeMode[x.tradeMode] = byTradeMode[x.tradeMode] || { count: 0, rejects: 0, slippage: 0, latency: 0 };
    byTradeMode[x.tradeMode].count += 1;
    byTradeMode[x.tradeMode].rejects += x.rejected ? 1 : 0;
    byTradeMode[x.tradeMode].slippage += Math.abs(Number(x.slippagePips || 0));
    byTradeMode[x.tradeMode].latency += Math.max(0, Number(x.latencyMs || 0));
  }

  const normalize = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, {
    count: v.count,
    rejectRate: Number((v.rejects / Math.max(1, v.count)).toFixed(4)),
    avgSlippagePips: Number((v.slippage / Math.max(1, v.count)).toFixed(4)),
    avgLatencyMs: Number((v.latency / Math.max(1, v.count)).toFixed(2))
  }]));

  return {
    sampleSize: n,
    rejectRate: n ? Number((rejects / n).toFixed(4)) : 0,
    avgSlippagePips: n ? Number((slip.reduce((s, v) => s + v, 0) / n).toFixed(4)) : 0,
    p95SlippagePips: Number(percentile(slip, 0.95).toFixed(4)),
    p99SlippagePips: Number(percentile(slip, 0.99).toFixed(4)),
    avgLatencyMs: n ? Number((lat.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0,
    p95LatencyMs: Number(percentile(lat, 0.95).toFixed(2)),
    p99LatencyMs: Number(percentile(lat, 0.99).toFixed(2)),
    avgDecisionLatencyMs: n ? Number((decisionLat.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0,
    p95DecisionLatencyMs: Number(percentile(decisionLat, 0.95).toFixed(2)),
    p99DecisionLatencyMs: Number(percentile(decisionLat, 0.99).toFixed(2)),
    avgPipelineLatencyMs: n ? Number((pipelineLat.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0,
    p95PipelineLatencyMs: Number(percentile(pipelineLat, 0.95).toFixed(2)),
    p99PipelineLatencyMs: Number(percentile(pipelineLat, 0.99).toFixed(2)),
    avgSpreadPips: Number(avgSpread.toFixed(4)),
    spreadStdPips: Number(Math.sqrt(Math.max(spreadVariance, 0)).toFixed(4)),
    edgeScore: {
      sampleSize: edgeScores.length,
      avg: edgeScores.length ? Number((edgeScores.reduce((s, v) => s + v, 0) / edgeScores.length).toFixed(4)) : 0,
      p95: Number(percentile(edgeScores, 0.95).toFixed(4))
    },
    sizingMultiplier: {
      sampleSize: sizingMultipliers.length,
      avg: sizingMultipliers.length ? Number((sizingMultipliers.reduce((s, v) => s + v, 0) / sizingMultipliers.length).toFixed(4)) : 0,
      p95: Number(percentile(sizingMultipliers, 0.95).toFixed(4))
    },
    bySession: normalize(bySession),
    byEventTag: normalize(byTag),
    byTradeMode: normalize(byTradeMode)
  };
}

export function flushExecutionTelemetry() {
  flushNow();
}
