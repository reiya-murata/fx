import http from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { buildAssistantDecision } from "./engine/assistant.js";
import { simulateOrderLifecycle } from "./execution/stateMachine.js";
import { loadState, withState } from "./data/store.js";
import {
  analyticsAssistantImpact,
  analyticsByHour,
  analyticsByWeekday,
  analyticsEventImpact,
  analyticsGatePerformance,
  analyticsSummary,
  analyticsValidationReport200
} from "./services/analytics.js";
import { MarketHub } from "./market/hub.js";
import { normalizeNewsItem } from "./services/news.js";
import {
  computeAtrTrailingStop,
  computePartialExitPlan,
  evaluateStopRequestExit,
  planAutoHold,
  shouldRiskCutPosition
} from "./engine/autoExit.js";
import { atr } from "./engine/indicators.js";
import { collectNewsOnce, parseFeedList } from "./services/newsCollector.js";
import { decideBanditGuard, retrainBanditFromTrades, updateBanditFromTrade } from "./services/rlBandit.js";
import { createPolicySnapshot, listPolicySnapshots, restorePolicySnapshot } from "./services/rlBandit.js";
import { buildExecutionConfig } from "./services/executionProfile.js";
import { detectUsdJpySession } from "./services/executionProfile.js";
import { appendLearningReport, listLearningReports } from "./services/learningReports.js";
import { computeWalkForwardTuning } from "./services/walkForward.js";
import { evaluateExpectancyGate, evaluateWalkForwardGate } from "./services/tradeGates.js";
import { evaluateMetaGate } from "./services/metaGate.js";
import { calculateUsdJpyPositionSizing, formatUnitsText, optimizePositionSize } from "./services/positionSizing.js";
import { evaluateFinalSizingGuard } from "./services/finalSizingGuard.js";
import { computeExecutionCalibration } from "./services/executionCalibration.js";
import { computeExecutionCalibrationFromTelemetry } from "./services/executionCalibration.js";
import { evaluateContextValidation } from "./services/contextValidation.js";
import { loadLearningMemory, resetLearningMemory, updateLearningMemoryFromTrades } from "./services/learningMemory.js";
import { computeObjectiveScore } from "./services/objective.js";
import { allocateRiskPercent } from "./services/capitalAllocator.js";
import { buildExitLearningAdjustment } from "./services/exitLearning.js";
import { buildConfidenceCalibration, calibrateSignalConfidence } from "./services/confidenceCalibration.js";
import { evaluatePreTradeGuard } from "./services/preTradeGuard.js";
import { evaluateDegradationGuard } from "./services/degradationGuard.js";
import { evaluateEnsembleGate } from "./services/ensembleGate.js";
import { evaluatePatternQualityGate } from "./services/patternQualityGate.js";
import { evaluateCapitalScaling } from "./services/capitalScaling.js";
import {
  computeEdgeSizingMultiplier,
  computeExecutionQualityScore,
  computeLatencySizingMultiplier,
  computeTailPenaltyMultiplier,
  evaluateKillSwitch,
  evaluateNoTradeZoneSchedule,
  evaluateRollingExpectancy
} from "./services/autoSafety.js";
import { appendExecutionTelemetry, getExecutionTelemetryStats, listExecutionTelemetry } from "./services/executionTelemetry.js";
import { flushExecutionTelemetry } from "./services/executionTelemetry.js";
import { buildBlockingSummary } from "./services/diagnostics/blockingSummary.js";
import {
  applyProfileConfidence,
  buildSignalConfigForProfile,
  evaluateShadowPromotion,
  listShadowProfiles,
  selectProfileByThompson
} from "./services/shadowAb.js";
import { applyBrokerProfile } from "./config/brokerProfiles.js";
import {
  buildAblationReport,
  buildMonthlyPerformanceReport,
  buildWeeklyFrequencyReport
} from "./services/reporting.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = resolve(process.cwd(), "public");
const BOOTSTRAP_CONTEXT_PATH = resolve(process.cwd(), "data/bootstrap_context_samples.json");
const AUTO_LOOP_MS = 100;
const NEWS_LOOP_MS = Math.max(10000, Number(process.env.NEWS_POLL_MS || 120000));
const SHADOW_LEARNING_LOOP_MS = Math.max(1000, Number(process.env.SHADOW_LEARNING_LOOP_MS || 5000));
const PAPER_LIVE_MODE = String(process.env.PAPER_LIVE || "0") === "1";
const inferredBrokerProfile = String(process.env.MARKET_HTTP_PROVIDER || "").toUpperCase() === "GMO_FX"
  ? "GMO_FX"
  : "SBI_FX";
const BROKER_PROFILE = process.env.BROKER_PROFILE || inferredBrokerProfile;
const BROKER_ORDER_MODE = String(process.env.BROKER_ORDER_MODE || "SIMULATED").trim().toUpperCase();
const BROKER_ORDER_LIVE_MANUAL = String(process.env.BROKER_ORDER_LIVE_MANUAL || "0") === "1";
const BROKER_ORDER_PROVIDER = String(process.env.BROKER_ORDER_PROVIDER || "").trim().toUpperCase();
const BROKER_ORDER_HTTP_URL = String(process.env.BROKER_ORDER_HTTP_URL || "").trim();
const BROKER_ORDER_TIMEOUT_MS = Math.max(1000, Number(process.env.BROKER_ORDER_TIMEOUT_MS || 6000));
const BROKER_ORDER_HEADERS = parseJsonObject(process.env.BROKER_ORDER_HEADERS_JSON || "");
const BROKER_ORDER_SYMBOL = String(process.env.BROKER_ORDER_SYMBOL || "USD_JPY").trim();
const GMO_FX_API_BASE_URL = String(process.env.GMO_FX_API_BASE_URL || "https://forex-api.coin.z.com").trim();
const GMO_FX_ORDER_PATH = String(process.env.GMO_FX_ORDER_PATH || "/private/v1/order").trim();
const GMO_FX_API_KEY = String(process.env.GMO_FX_API_KEY || "").trim();
const GMO_FX_API_SECRET = String(process.env.GMO_FX_API_SECRET || "").trim();
const GMO_FX_HEADER_KEY = String(process.env.GMO_FX_HEADER_KEY || "API-KEY").trim();
const GMO_FX_HEADER_TIMESTAMP = String(process.env.GMO_FX_HEADER_TIMESTAMP || "API-TIMESTAMP").trim();
const GMO_FX_HEADER_SIGN = String(process.env.GMO_FX_HEADER_SIGN || "API-SIGN").trim();
const RUNTIME_CONFIG = applyBrokerProfile(DEFAULT_CONFIG, BROKER_PROFILE);
const BOOTSTRAP_CONTEXT_COUNTS = loadBootstrapContextCounts();
const market = new MarketHub({
  wsUrl: process.env.MARKET_WS_URL || "",
  wsSubscribeMessage: process.env.MARKET_WS_SUBSCRIBE || ""
});
market.start();
const autoRuntime = {
  lastRunMs: 0,
  lastRunAt: null,
  lastAction: "IDLE",
  active: false,
  enabledSince: null,
  cooldownUntilMs: 0,
  cooldownReason: null,
  rollingRescueCooldownUntilMs: 0,
  rollingRescueReason: null,
  lastSkipReason: null,
  lastSignalRationale: null,
  lastSnapshotAtMs: 0,
  lastSnapshotTradeCount: 0,
  lastRollbackAtMs: 0,
  rollbackWarmupUntilMs: 0,
  anomalyMode: "NORMAL",
  anomalyModeUntilMs: 0,
  lastWalkForwardGate: null,
  lastExpectancyGate: null,
  lastMetaGate: null,
  lastContextValidation: null,
  lastSizing: null,
  lastObjective: null,
  lastCapitalAllocation: null,
  lastExitLearning: null,
  lastConfidenceCalibration: null,
  lastPreTradeGuard: null,
  lastDegradationGuard: null,
  lastEnsembleGate: null,
  lastPatternQualityGate: null,
  lastKillSwitch: null,
  lastRollingExpectancy: null,
  lastExecutionTailGate: null,
  lastNoTradeZone: null,
  lastPositionSizingDiagnostics: null,
  lastReentryGuard: null,
  lastDecisionTrace: null,
  lastEntryEvidenceBreakdown: null,
  lastEntryLocationDiagnostics: null,
  lastMultiTimeframeDiagnostics: null,
  lastNoActionableSignalDiagnostics: null,
  lastSizingTrace: null,
  lastTrendUpEntryQuality: null,
  lastEarlyAdverseExitDiagnostics: null,
  lastFastPeakProtectDiagnostics: null,
  lastEdgeSizing: null,
  lastTradeMode: "BASE",
  lastAggressiveEligibility: { eligible: false, reason: "not-evaluated", reasons: [] },
  lastTradeModeEligibility: {
    base: { eligible: true, reason: "default", reasons: [] },
    semi: { eligible: false, reason: "not-evaluated", reasons: [] },
    full: { eligible: false, reason: "not-evaluated", reasons: [] }
  },
  rollingRescueStage: 0,
  executionCalibration: {
    enabled: false,
    ready: false,
    rejectRateAdj: 0,
    slippageAdj: 1,
    latencyAdj: 1
  },
  processLatency: {
    last: null,
    ewma: null,
    samples: 0
  },
  learningMemory: loadLearningMemory(),
  banditGuardHoldStreak: 0,
  banditGuardStreakStartedMs: 0,
  banditGuardLastContext: null,
  banditGuardBypassCount: 0,
  executionTailGuardUntilMs: 0,
  executionTailGuardReason: null,
  consecutiveErrors: 0,
  lastError: null
};
const reportRuntime = {
  lastWeeklyKey: null,
  lastMonthlyKey: null
};
const newsRuntime = {
  active: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFetchedCount: 0,
  lastInsertedCount: 0,
  lastMatchedCount: 0,
  consecutiveErrors: 0,
  lastError: null
};
const dailyLearningRuntime = {
  active: false,
  lastRunAt: null,
  lastDateJst: null,
  lastError: null,
  consecutiveErrors: 0
};
const shadowLearningRuntime = {
  active: false,
  positionsByProfile: {},
  tradesByProfile: {},
  lastPromotion: null,
  thompsonDraws: {},
  exploreProfile: "BASELINE",
  approvedProfile: "BASELINE",
  updates: 0,
  lastRunAt: null,
  lastError: null,
  consecutiveErrors: 0
};
initializeShadowRuntime();

function initializeShadowRuntime() {
  const profiles = listShadowProfiles(RUNTIME_CONFIG.shadowAB || {});
  for (const profile of profiles) {
    if (!(profile in shadowLearningRuntime.positionsByProfile)) {
      shadowLearningRuntime.positionsByProfile[profile] = null;
    }
    if (!Array.isArray(shadowLearningRuntime.tradesByProfile[profile])) {
      shadowLearningRuntime.tradesByProfile[profile] = [];
    }
  }
  if (!profiles.includes(shadowLearningRuntime.approvedProfile)) {
    shadowLearningRuntime.approvedProfile = "BASELINE";
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function loadBootstrapContextCounts() {
  try {
    if (!existsSync(BOOTSTRAP_CONTEXT_PATH)) return {};
    const raw = readFileSync(BOOTSTRAP_CONTEXT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const counts = parsed?.contextCounts;
    if (!counts || typeof counts !== "object") return {};
    return counts;
  } catch {
    return {};
  }
}

function sendText(res, status, content, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(content);
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function contentTypeFor(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function serveStatic(pathname, res) {
  const path = pathname === "/" ? "/index.html" : pathname;
  const fullPath = resolve(PUBLIC_DIR, `.${path}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return true;
  }
  if (!existsSync(fullPath)) return false;
  const content = readFileSync(fullPath);
  sendText(res, 200, content, contentTypeFor(fullPath));
  return true;
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  return JSON.parse(data);
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function calculateNetPnlJpy(side, entryPrice, exitPrice, qty, feeJpy = 0) {
  const gross = side === "BUY" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  return Number((gross - feeJpy).toFixed(2));
}

function isValidTradeRecord(trade) {
  const entry = Number(trade?.entryPrice || 0);
  const exit = Number(trade?.exitPrice || 0);
  const qty = Number(trade?.qty || 0);
  const pnl = Number(trade?.netPnlJpy || 0);
  return Number.isFinite(entry) && entry > 0
    && Number.isFinite(exit) && exit > 0
    && Number.isFinite(qty) && qty > 0
    && Number.isFinite(pnl);
}

function safeExitPriceForSide(side, tick) {
  const raw = side === "BUY" ? Number(tick?.bid) : Number(tick?.ask);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Number(raw.toFixed(3));
}
function positiveNum(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const f = Number(fallback);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

function updateConsecutiveLosses(current, pnl) {
  if (pnl < 0) return current + 1;
  if (pnl > 0) return 0;
  return current;
}

function applyExitAdjustmentsToSignal(signal, exitLearning) {
  const enabled = Boolean(exitLearning?.enabled) && !Boolean(exitLearning?.pending);
  if (!enabled) return signal;
  if (!(signal?.action === "BUY" || signal?.action === "SELL")) return signal;
  const entry = Number(signal.entryPrice || 0);
  const stop = Number(signal.stopLossPrice || 0);
  const take = Number(signal.takeProfitPrice || 0);
  if (!(entry > 0) || !(stop > 0) || !(take > 0)) return signal;

  const stopDistance = Math.abs(entry - stop);
  const takeDistance = Math.abs(take - entry);
  if (!(stopDistance > 0) || !(takeDistance > 0)) return signal;

  const minDistance = Math.max(Number(RUNTIME_CONFIG.pipSize || 0.01), 1e-6);
  const slMultiplier = clamp(Number(exitLearning.slMultiplier || 1), 0.5, 1.8);
  const tpMultiplier = clamp(Number(exitLearning.tpMultiplier || 1), 0.5, 1.8);
  const nextStopDistance = Math.max(minDistance, stopDistance * slMultiplier);
  const nextTakeDistance = Math.max(minDistance, takeDistance * tpMultiplier);

  const isBuy = signal.action === "BUY";
  const stopLossPrice = isBuy
    ? Number((entry - nextStopDistance).toFixed(6))
    : Number((entry + nextStopDistance).toFixed(6));
  const takeProfitPrice = isBuy
    ? Number((entry + nextTakeDistance).toFixed(6))
    : Number((entry - nextTakeDistance).toFixed(6));

  return {
    ...signal,
    stopLossPrice,
    takeProfitPrice
  };
}

function buildDecisionHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
}

function appendAudit(state, event, details) {
  return {
    ...state,
    auditLogs: [...state.auditLogs.slice(-4999), {
      id: randomUUID(),
      ts: new Date().toISOString(),
      event,
      ...details
    }]
  };
}

async function refreshMarketTickForStatus() {
  await market.refreshHttpTickNow?.();
}

async function handleTicker(res) {
  await refreshMarketTickForStatus();
  const ticker = market.getTicker?.() || market.step();
  send(res, 200, {
    ...ticker,
    marketStatus: market.getMarketStatus()
  });
}

function normalizeExecutionModeInput(value, fallback = "PAPER_LIVE") {
  return normalizeAutoExecutionMode(value ?? fallback);
}

function resolveApiMode(state, url = null) {
  const modeParam = url?.searchParams?.get?.("mode");
  return normalizeExecutionModeInput(modeParam, state?.settings?.autoExecutionMode || "PAPER_LIVE");
}

function tradeModeOf(trade) {
  return normalizeExecutionModeInput(trade?.executionMode, "PAPER_LIVE");
}

function positionModeOf(position) {
  return normalizeExecutionModeInput(position?.executionMode, "PAPER_LIVE");
}

function filterTradesByMode(trades, mode) {
  return (Array.isArray(trades) ? trades : []).filter((t) => tradeModeOf(t) === mode && isValidTradeRecord(t));
}

function filterPositionsByMode(positions, mode) {
  return (Array.isArray(positions) ? positions : []).filter((p) => positionModeOf(p) === mode);
}

function trailingLossesFromTrades(trades) {
  const sorted = [...(Array.isArray(trades) ? trades : [])]
    .filter(isValidTradeRecord)
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
  let count = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (Number(sorted[i]?.netPnlJpy || 0) < 0) count += 1;
    else break;
  }
  return count;
}

function getConfiguredCapitalJpy(state, mode) {
  const settings = state?.settings || {};
  if (mode === "LIVE") return Math.max(10000, Number(settings.liveCapitalJpy || 10000));
  return Math.max(10000, Number(settings.paperCapitalJpy || 10000));
}

function buildModeAccountView(state, mode) {
  const initial = getConfiguredCapitalJpy(state, mode);
  const trades = filterTradesByMode(state?.trades || [], mode);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const dayPnlJpy = Number(trades
    .filter((t) => {
      const tt = new Date(t.exitTime || t.entryTime || 0);
      return tt.getFullYear() === y && tt.getMonth() === m && tt.getDate() === d;
    })
    .reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2));
  const realizedPnl = Number(trades.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2));
  const currentBalanceJpy = Number((initial + realizedPnl).toFixed(2));
  return {
    initialBalanceJpy: Number(initial.toFixed(2)),
    currentBalanceJpy,
    dayPnlJpy,
    weekDrawdownJpy: dayPnlJpy < 0 ? Math.abs(dayPnlJpy) : 0,
    consecutiveLosses: trailingLossesFromTrades(trades),
    executionMode: mode
  };
}

function getRiskCapitalJpy(state, mode) {
  const account = buildModeAccountView(state, mode);
  return Math.max(1, Number(account.currentBalanceJpy || account.initialBalanceJpy || 10000));
}

function buildAccountRuntime(state) {
  const paper = buildModeAccountView(state, "PAPER_LIVE");
  const live = buildModeAccountView(state, "LIVE");
  const toRuntime = (account) => ({
    initialCapitalJPY: Number(account.initialBalanceJpy || 0),
    currentEquityJPY: Number(account.currentBalanceJpy || 0),
    realizedPnlJPY: Number((Number(account.currentBalanceJpy || 0) - Number(account.initialBalanceJpy || 0)).toFixed(2)),
    dailyLossJPY: Math.max(0, -Number(account.dayPnlJpy || 0)),
    maxDrawdownPct: Number(account.initialBalanceJpy || 0) > 0
      ? Number((((Number(account.initialBalanceJpy || 0) - Number(account.currentBalanceJpy || 0)) / Number(account.initialBalanceJpy || 1)) * 100).toFixed(4))
      : 0
  });
  return {
    PAPER_LIVE: toRuntime(paper),
    LIVE: toRuntime(live)
  };
}

function resolveRiskProfile(profileName) {
  const profiles = RUNTIME_CONFIG.riskProfiles || {};
  const key = String(profileName || RUNTIME_CONFIG.positionSizing?.selectedRiskProfile || "smallCapitalAggressive");
  return profiles[key] || profiles.smallCapitalAggressive || {};
}

function buildPositionSizingSettings(settings = {}, modeAccount = null, capitalScaling = null) {
  const cfg = RUNTIME_CONFIG.positionSizing || {};
  const broker = RUNTIME_CONFIG.brokerProfile || {};
  const selectedRiskProfile = String(settings.selectedRiskProfile || cfg.selectedRiskProfile || "smallCapitalAggressive");
  const profile = resolveRiskProfile(selectedRiskProfile);
  const scaling = capitalScaling?.settingsOverride || {};
  return {
    balanceJPY: Number(modeAccount?.currentBalanceJpy ?? settings.balanceJPY ?? profile.initialBalanceJPY ?? cfg.balanceJPY ?? 10000),
    riskPercentPerTrade: Number(scaling.riskPercentPerTrade ?? settings.riskPercentPerTrade ?? settings.autoRiskPercentPerTrade ?? cfg.riskPercentPerTrade ?? 5),
    riskAmountJPY: Number(settings.riskAmountJPY ?? profile.riskAmountJPY ?? cfg.riskAmountJPY ?? 500),
    sizingMode: String(settings.sizingMode || cfg.sizingMode || "riskPercent") === "fixedRiskJPY" ? "fixedRiskJPY" : "riskPercent",
    selectedRiskProfile,
    maxEffectiveLeverage: Number(scaling.maxEffectiveLeverage ?? settings.maxEffectiveLeverage ?? profile.maxEffectiveLeverage ?? cfg.maxEffectiveLeverage ?? 20),
    legalMaxLeverage: Number(settings.legalMaxLeverage ?? profile.legalMaxLeverage ?? broker.legalMaxLeverage ?? cfg.legalMaxLeverage ?? 25),
    requiredMarginRate: Number(settings.requiredMarginRate ?? broker.requiredMarginRate ?? cfg.requiredMarginRate ?? 0.04),
    minUnits: Number(broker.minUnits ?? settings.minUnits ?? cfg.minUnits ?? 100),
    brokerMinUnits: Number(broker.minUnits ?? settings.brokerMinUnits ?? settings.minUnits ?? cfg.brokerMinUnits ?? 100),
    unitStep: Number(broker.unitStep ?? settings.unitStep ?? cfg.unitStep ?? 100),
    maxUnits: Number(settings.maxUnits ?? cfg.maxUnits ?? 50000),
    maxRiskAmountJPY: Number(settings.maxRiskAmountJPY ?? profile.maxRiskAmountJPY ?? cfg.maxRiskAmountJPY ?? 1000),
    maxRiskPercentPerTrade: Number(scaling.maxRiskPercentPerTrade ?? settings.maxRiskPercentPerTrade ?? profile.maxRiskPercentPerTrade ?? cfg.maxRiskPercentPerTrade ?? 8),
    warningRiskPercentPerTrade: Number(settings.warningRiskPercentPerTrade ?? profile.warningRiskPercentPerTrade ?? cfg.warningRiskPercentPerTrade ?? 5),
    dangerRiskPercentPerTrade: Number(settings.dangerRiskPercentPerTrade ?? profile.dangerRiskPercentPerTrade ?? cfg.dangerRiskPercentPerTrade ?? 10),
    hardBlockRiskPercentPerTrade: Number(settings.hardBlockRiskPercentPerTrade ?? profile.hardBlockRiskPercentPerTrade ?? cfg.hardBlockRiskPercentPerTrade ?? 15),
    warningEffectiveLeverage: Number(settings.warningEffectiveLeverage ?? profile.warningEffectiveLeverage ?? cfg.warningEffectiveLeverage ?? 15)
  };
}

function normalizePositionSizingBody(body = {}) {
  const out = {};
  if (typeof body.balanceJPY === "number") out.balanceJPY = Math.round(clamp(Number(body.balanceJPY), 1, 1000000000));
  if (typeof body.riskPercentPerTrade === "number") out.riskPercentPerTrade = Number(clamp(Number(body.riskPercentPerTrade), 0.1, 15).toFixed(2));
  if (typeof body.riskAmountJPY === "number") out.riskAmountJPY = Math.round(clamp(Number(body.riskAmountJPY), 1, 100000000));
  if (body.sizingMode !== undefined) out.sizingMode = String(body.sizingMode) === "fixedRiskJPY" ? "fixedRiskJPY" : "riskPercent";
  if (body.selectedRiskProfile !== undefined) out.selectedRiskProfile = String(body.selectedRiskProfile) === "conservative" ? "conservative" : "smallCapitalAggressive";
  if (typeof body.maxEffectiveLeverage === "number") out.maxEffectiveLeverage = Number(clamp(Number(body.maxEffectiveLeverage), 1, 25).toFixed(2));
  if (typeof body.legalMaxLeverage === "number") out.legalMaxLeverage = Number(clamp(Number(body.legalMaxLeverage), 1, 25).toFixed(2));
  if (typeof body.requiredMarginRate === "number") out.requiredMarginRate = Number(clamp(Number(body.requiredMarginRate), 0.04, 1).toFixed(4));
  if (typeof body.minUnits === "number") out.minUnits = Math.round(clamp(Number(body.minUnits), 1, 100000000));
  if (typeof body.brokerMinUnits === "number") out.brokerMinUnits = Math.round(clamp(Number(body.brokerMinUnits), 1, 100000000));
  if (typeof body.unitStep === "number") out.unitStep = Math.round(clamp(Number(body.unitStep), 1, 100000000));
  if (typeof body.maxUnits === "number") out.maxUnits = Math.round(clamp(Number(body.maxUnits), 1, 100000000));
  if (typeof body.maxRiskAmountJPY === "number") out.maxRiskAmountJPY = Math.round(clamp(Number(body.maxRiskAmountJPY), 1, 100000000));
  return out;
}

function estimateStopLossPipsFromSignal(signal, entryPrice) {
  return estimateStopLossPipsInfo(signal, entryPrice).stopLossPips;
}

function estimateStopLossPipsInfo(signal, entryPrice) {
  const pipSize = Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01));
  const entry = Number(entryPrice || signal?.entryPrice || 0);
  const sl = Number(signal?.stopLossPrice || 0);
  const fallback = Number(RUNTIME_CONFIG.positionSizing?.defaultStopLossPips || 3);
  if (entry > 0 && sl > 0) {
    return {
      stopLossPips: Math.max(0.01, Math.abs(entry - sl) / pipSize),
      stopLossSource: "signal",
      stopLossFallbackUsed: false,
      stopLossFallbackWarning: null
    };
  }
  return {
    stopLossPips: fallback,
    stopLossSource: "fallback",
    stopLossFallbackUsed: true,
    stopLossFallbackWarning: "stopLossPriceがないため、PAPER_LIVEではfallback SLを使います。LIVEではブロックします。"
  };
}

function buildPositionSizingDiagnostics({ state, signal = null, price = 0, sizeMultiplier = 1, maxUnitsOverride = null, executionMode = null, capitalScaling = null } = {}) {
  const mode = executionMode ? normalizeExecutionModeInput(executionMode, "PAPER_LIVE") : null;
  const modeAccount = mode ? buildModeAccountView(state, mode) : null;
  const settings = buildPositionSizingSettings(state?.settings || {}, modeAccount, capitalScaling);
  const stopInfo = estimateStopLossPipsInfo(signal, price);
  const out = calculateUsdJpyPositionSizing({
    settings,
    stopLossPips: stopInfo.stopLossPips,
    currentUsdJpyPrice: price,
    leverage: RUNTIME_CONFIG.positionSizing?.marginLeverage || 25,
    sizeMultiplier,
    maxUnitsOverride
  });
  return {
    ...out,
    ...stopInfo,
    selectedRiskProfile: settings.selectedRiskProfile,
    capitalScalingDiagnostics: capitalScaling?.diagnostics || null
  };
}

function buildManualSizingDiagnostics({ state, qty, price, stopLossPips, executionMode } = {}) {
  const modeAccount = buildModeAccountView(state, normalizeExecutionModeInput(executionMode, "PAPER_LIVE"));
  const settings = buildPositionSizingSettings(state?.settings || {}, modeAccount);
  const units = Math.round(Number(qty || 0));
  const p = Number(price || 0);
  const sl = Number(stopLossPips || 0);
  const estimatedExposureJPY = units * p;
  const requiredMarginJPY = estimatedExposureJPY / Math.max(1, Number(RUNTIME_CONFIG.positionSizing?.marginLeverage || 25));
  const effectiveLeverage = modeAccount.currentBalanceJpy > 0 ? estimatedExposureJPY / modeAccount.currentBalanceJpy : 0;
  const estimatedLossJPY = sl > 0 ? sl * units * 0.01 : 0;
  return {
    ...settings,
    balanceJPY: Number(modeAccount.currentBalanceJpy || settings.balanceJPY || 0),
    calculatedUnits: units,
    displayUnitsText: formatUnitsText(units),
    stopLossPips: sl,
    estimatedLossJPY: Number(estimatedLossJPY.toFixed(2)),
    estimatedExposureJPY: Number(estimatedExposureJPY.toFixed(2)),
    requiredMarginJPY: Number(requiredMarginJPY.toFixed(2)),
    effectiveLeverage: Number(effectiveLeverage.toFixed(4)),
    stopLossSource: sl > 0 ? "manual" : "missing",
    stopLossFallbackUsed: false,
    maxRiskAmountJPY: Number(settings.maxRiskAmountJPY || 1000),
    blockedReason: null
  };
}

function buildCapitalScalingStatus(state, executionMode = "PAPER_LIVE") {
  const mode = normalizeExecutionModeInput(executionMode, "PAPER_LIVE");
  const account = buildModeAccountView(state, mode);
  const out = evaluateCapitalScaling({
    state,
    currentBalanceJPY: Number(account.currentBalanceJpy || 0),
    cfg: RUNTIME_CONFIG.capitalScaling || {},
    now: new Date()
  });
  return {
    enabled: Boolean(out.enabled),
    activeTierId: out.runtime?.activeTierId || "",
    candidateTierId: out.runtime?.candidateTierId || "",
    activeTier: out.activeTier || null,
    candidateTier: out.candidateTier || null,
    promotionStatus: {
      eligible: Boolean(out.diagnostics?.promotionEligible),
      blockedReasons: out.diagnostics?.promotionBlockedReasons || [],
      tradesSinceCandidateTierReached: Number(out.diagnostics?.tradesSinceCandidateTierReached || 0),
      requiredTrades: Number(out.diagnostics?.promotionRequiredTrades || 30)
    },
    demotionStatus: {
      triggered: Boolean(out.diagnostics?.demotionTriggered),
      reasons: out.diagnostics?.demotionReasons || []
    },
    fullUnlockStatus: out.diagnostics?.fullUnlockStatus || "LOCKED",
    diagnostics: out.diagnostics || { enabled: false }
  };
}

function handleTickerStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const emit = () => {
    const ticker = market.step();
    res.write("event: ticker\n");
    res.write(`data: ${JSON.stringify({
      ...ticker,
      marketStatus: market.getMarketStatus()
    })}\n\n`);
  };

  emit();
  const timer = setInterval(emit, 1000);
  res.on("close", () => clearInterval(timer));
}

function handleCandles(res, url) {
  const tf = url.searchParams.get("tf") || "1m";
  const limit = Number(url.searchParams.get("limit") || 120);
  send(res, 200, {
    symbol: "USDJPY",
    tf,
    candles: market.getCandles(tf, limit),
    marketStatus: market.getMarketStatus()
  });
}

async function handleMarketStatus(res) {
  await refreshMarketTickForStatus();
  send(res, 200, market.getMarketStatus());
}

function generateSignalFromState(state, riskPercentOverride = null, options = {}) {
  const ticker = options.ticker || market.step();
  const sets = options.sets || market.getDecisionCandles();
  const decisionTimestamp = new Date().toISOString();
  const signalProfile = String(options.signalProfile || "BASELINE").toUpperCase();
  const runtimeConfig = options.runtimeConfig || buildSignalConfigForProfile(RUNTIME_CONFIG, signalProfile);
  const decisionInputHash = buildDecisionHash({
    bid: ticker.bid,
    ask: ticker.ask,
    spreadPips: ticker.spreadPips,
    orderBookImbalance: ticker.orderBookImbalance,
    newsTop: (state.newsEvents || []).slice(-5).map((n) => [n.id, n.impact, n.ts, n.eventTime]),
    c1Last: sets.candles1m.at(-1),
    c5Last: sets.candles5m.at(-1),
    c15Last: sets.candles15m.at(-1),
    settings: state.settings
  });

  const activeExecutionMode = normalizeExecutionModeInput(state.settings.autoExecutionMode, "PAPER_LIVE");
  const isGmoHttpPaperLive = String(process.env.MARKET_HTTP_PROVIDER || "").toUpperCase() === "GMO_FX" && activeExecutionMode === "PAPER_LIVE";

  const decisionRaw = buildAssistantDecision({
    ...ticker,
    ...sets,
    account: state.account,
    trades: state.trades,
    newsEvents: state.newsEvents,
    maxRiskPercentPerTrade: riskPercentOverride ?? state.settings.autoRiskPercentPerTrade ?? state.settings.maxRiskPercentPerTrade,
    enableSelfLearning: true,
    enableWalkForward: state.settings.enableWalkForward,
    enableNewsFilter: true,
    blockHighImpactNews: true,
    shadowLearningMode: true,
    preEventBlockMinutes: runtimeConfig.news.preEventBlockMinutes,
    postEventBlockMinutes: runtimeConfig.news.postEventBlockMinutes,
    marketFeatures: {
      isGmoHttpPaperLive
    }
  }, runtimeConfig);
  const decision = applyProfileConfidence(decisionRaw, runtimeConfig, signalProfile);

  const capitalScaling = buildCapitalScalingStatus(state, activeExecutionMode);

  const signal = {
    id: randomUUID(),
    ts: decisionTimestamp,
    marketTimestamp: ticker.ts,
    decisionInputHash,
    signalVersion: RUNTIME_CONFIG.signalVersion,
    parameterSnapshot: {
      settings: state.settings,
      effectiveRiskSettings: {
        ...state.settings,
        ...(capitalScaling.diagnostics || {})
      },
      signalProfile,
      executionGate: runtimeConfig.executionGate,
      spread: runtimeConfig.spread
    },
    ...decision,
    symbol: "USDJPY",
    signalProfile
  };

  return {
    ticker,
    signal,
    decisionTimestamp,
    decisionInputHash
  };
}

function handleRecommendation(res) {
  const state = loadState();
  const { ticker, signal, decisionTimestamp, decisionInputHash } = generateSignalFromState(
    state,
    null,
    { signalProfile: shadowLearningRuntime.approvedProfile || "BASELINE" }
  );

  withState((s) => appendAudit({
    ...s,
    assistantSignals: [...s.assistantSignals.slice(-499), signal]
  }, "signal.generated", {
    signalId: signal.id,
    decisionTimestamp,
    marketTimestamp: ticker.ts,
    decisionInputHash,
    action: signal.action
  }));

  send(res, 200, signal);
}

function handleTradesList(res, url) {
  const state = loadState();
  const mode = resolveApiMode(state, url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));
  const list = filterTradesByMode(state.trades, mode);
  const trades = [...list].sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime)).slice(0, limit);
  send(res, 200, { items: trades, total: list.length, mode });
}

function handlePositionsList(res, url) {
  const state = loadState();
  const mode = resolveApiMode(state, url);
  const items = filterPositionsByMode(state.positions, mode);
  send(res, 200, { items, total: items.length, mode });
}

function closePositionById(state, positionId, marketTick, reason = "manual-close") {
  const nowMs = Date.now();
  let closedTrade = null;
  let account = { ...state.account };

  const positions = state.positions.map((position) => {
    if (!(position.id === positionId && position.status === "OPEN")) return position;

    const side = position.side === "LONG" ? "BUY" : "SELL";
    const exitPrice = safeExitPriceForSide(side, marketTick);
    if (!(exitPrice > 0)) {
      return position;
    }
    const holdingSeconds = Math.max(0.1, Number(((nowMs - new Date(position.openedAt).getTime()) / 1000).toFixed(3)));
    const exitFee = Number((((exitPrice * position.qty) * RUNTIME_CONFIG.execution.feeBps) / 10000).toFixed(2));
    const totalFee = Number((Number(position.entryFeeJpy || 0) + exitFee).toFixed(2));
    const netPnlJpy = calculateNetPnlJpy(side, Number(position.entryPrice), exitPrice, Number(position.qty), totalFee);

    closedTrade = {
      id: randomUUID(),
      symbol: "USDJPY",
      side,
      entryPrice: Number(position.entryPrice),
      exitPrice,
      qty: Number(position.qty),
      entryTime: position.openedAt,
      exitTime: new Date(nowMs).toISOString(),
      holdingSeconds,
      netPnlJpy,
      assistantAdopted: true,
      slippagePips: Number(position.slippagePips || 0),
      latencyMs: Number(position.latencyMs || 0),
      feeJpy: totalFee,
      exitReason: reason,
      regime: position.regime || null,
      signalId: position.signalId || null,
      signalRationale: position.signalRationale || null,
      signalConfidence: Number(position.signalConfidence || 0),
      signalMetrics: position.signalMetrics || null,
      signalAdaptive: position.signalAdaptive || null,
      signalNews: position.signalNews || null,
      linkedEventIds: Array.isArray(position.linkedEventIds) ? position.linkedEventIds : [],
      eventFeatureSnapshot: position.eventFeatureSnapshot || null,
      eventDominantTag: position.eventDominantTag || null,
      decisionInputHash: position.decisionInputHash || null,
      parameterSnapshot: position.parameterSnapshot || null,
      signalProfile: position.signalProfile || "BASELINE",
      selectedRiskPercent: Number(position.selectedRiskPercent || 0),
      banditContextKey: position.banditContextKey || null,
      banditHoldScore: Number(position.banditHoldScore || 0),
      banditActionScore: Number(position.banditActionScore || 0),
      banditAdvantage: Number(position.banditAdvantage || 0),
      banditSizeMultiplier: Number(position.banditSizeMultiplier || 1),
      executionSession: position.executionSession || null,
      executionStress: Number(position.executionStress || 0),
      executionEventStress: Number(position.executionEventStress || 0),
      executionEventTag: position.executionEventTag || null,
      executionMode: normalizeExecutionModeInput(position.executionMode, "PAPER_LIVE"),
      createdAt: new Date().toISOString()
    };

    account = applyTradeToAccount(account, closedTrade.netPnlJpy);
    return {
      ...position,
      status: "CLOSED",
      closedAt: closedTrade.exitTime,
      exitReason: reason
    };
  });

  if (!closedTrade) {
    return { found: false, state };
  }
  try {
    if (closedTrade.signalId) updateBanditFromTrade({ trade: closedTrade, config: getRuntimeLearningConfig() });
  } catch {}

  const nextState = appendAudit({
    ...state,
    account,
    positions,
    trades: [...state.trades, closedTrade]
  }, "position.closed", {
    positionId,
    tradeId: closedTrade.id,
    reason
  });

  return { found: true, state: nextState, trade: closedTrade };
}

function handleClosePosition(req, res, positionId) {
  const marketTick = market.step();
  const result = closePositionById(loadState(), positionId, marketTick, "manual-close");
  if (!result.found) return send(res, 404, { error: "Open position not found" });
  const next = withState(() => result.state);
  send(res, 200, { trade: result.trade, account: next.account });
}

async function handleCreateTrade(req, res) {
  const body = await readBody(req);
  const state = loadState();
  const executionMode = normalizeExecutionModeInput(body.executionMode, state.settings.autoExecutionMode);
  const required = ["side", "entryPrice", "exitPrice", "qty", "entryTime", "exitTime"];
  for (const key of required) {
    if (!(key in body)) return send(res, 400, { error: `Missing field: ${key}` });
  }

  const entryTime = new Date(body.entryTime).toISOString();
  const exitTime = new Date(body.exitTime).toISOString();
  const holdingSeconds = Math.max(1, Math.round((new Date(exitTime) - new Date(entryTime)) / 1000));
  const netPnlJpy = calculateNetPnlJpy(body.side, Number(body.entryPrice), Number(body.exitPrice), Number(body.qty), Number(body.feeJpy || 0));

  const trade = {
    id: randomUUID(),
    symbol: "USDJPY",
    side: body.side,
    entryPrice: Number(body.entryPrice),
    exitPrice: Number(body.exitPrice),
    qty: Number(body.qty),
    entryTime,
    exitTime,
    holdingSeconds,
    netPnlJpy,
    assistantAdopted: Boolean(body.assistantAdopted),
    slippagePips: Number(body.slippagePips || 0),
    latencyMs: Number(body.latencyMs || 0),
    feeJpy: Number(body.feeJpy || 0),
    exitReason: body.exitReason || "manual",
    regime: body.regime || null,
    executionMode,
    linkedEventIds: Array.isArray(body.linkedEventIds) ? body.linkedEventIds : [],
    eventFeatureSnapshot: body.eventFeatureSnapshot || null,
    eventDominantTag: body.eventDominantTag || null,
    createdAt: new Date().toISOString()
  };

  const next = withState((s) => {
    const currentBalanceJpy = Number((s.account.currentBalanceJpy + trade.netPnlJpy).toFixed(2));
    const dayPnlJpy = Number((s.account.dayPnlJpy + trade.netPnlJpy).toFixed(2));
    const weekDrawdownJpy = dayPnlJpy < 0 ? Math.abs(dayPnlJpy) : 0;

    return appendAudit({
      ...s,
      account: {
        ...s.account,
        currentBalanceJpy,
        dayPnlJpy,
        weekDrawdownJpy,
        consecutiveLosses: updateConsecutiveLosses(s.account.consecutiveLosses, trade.netPnlJpy)
      },
      trades: [...s.trades, trade]
    }, "trade.created", {
      tradeId: trade.id,
      netPnlJpy: trade.netPnlJpy,
      latencyMs: trade.latencyMs,
      slippagePips: trade.slippagePips
    });
  });

  send(res, 201, { trade, account: next.account });
}

async function handleExecuteOrder(req, res) {
  const body = await readBody(req);
  const side = body.side;
  const qty = Number(body.qty);
  if (!(side === "BUY" || side === "SELL") || !(qty > 0)) {
    return send(res, 400, { error: "side(BUY/SELL) and qty(>0) are required" });
  }

  const state = loadState();
  const executionMode = normalizeExecutionModeInput(body.executionMode, state.settings.autoExecutionMode);
  const marketTick = market.step();
  const marketStatus = market.getMarketStatus();
  if (!(marketStatus.fxOpen && marketStatus.realtime)) {
    return send(res, 409, {
      error: marketStatus.fxOpen
        ? `リアルタイム未接続 (${marketStatus.source})`
        : "市場クローズ中（土日）",
      marketStatus
    });
  }
  const requestedPrice = Number(body.requestedPrice || (side === "BUY" ? marketTick.ask : marketTick.bid) || 0);
  const stopLossPips = Number(body.stopLossPips || 0) > 0
    ? Number(body.stopLossPips)
    : (Number(body.stopLossPrice || 0) > 0 && requestedPrice > 0
      ? Math.abs(requestedPrice - Number(body.stopLossPrice)) / Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01))
      : 0);
  const manualSizingDiagnostics = buildManualSizingDiagnostics({
    state,
    qty,
    price: requestedPrice,
    stopLossPips,
    executionMode
  });
  const manualFinalGuard = evaluateFinalSizingGuard({
    qty,
    diagnostics: manualSizingDiagnostics,
    executionMode,
    availableCapitalJPY: buildModeAccountView(state, executionMode).currentBalanceJpy,
    requireStopLoss: executionMode === "LIVE"
  });
  if (!manualFinalGuard.allowed) {
    return send(res, 400, {
      error: "final sizing guard blocked",
      reason: manualFinalGuard.reason,
      finalSizingGuard: manualFinalGuard,
      positionSizingDiagnostics: manualSizingDiagnostics
    });
  }
  const executionProfile = buildExecutionConfig(getRuntimeExecutionConfig(), marketTick);
  const lifecycle = await executeOrderLifecycle({
    side,
    qty,
    requestedPrice,
    marketTick,
    executionConfig: executionProfile.config,
    allowLive: Boolean(BROKER_ORDER_LIVE_MANUAL || body.liveOrder === true)
  });
  appendExecutionTelemetry({
    source: "manual",
    session: executionProfile.session,
    eventTag: executionProfile.eventTag,
    spreadPips: Number(marketTick.spreadPips || 0),
    slippagePips: Number(lifecycle.slippagePips || 0),
    latencyMs: Number(lifecycle.latencyMs || 0),
    decisionLatencyMs: 0,
    totalPipelineLatencyMs: Number(lifecycle.latencyMs || 0),
    rejected: Boolean(lifecycle.rejected || lifecycle.executedQty <= 0),
    executedQty: Number(lifecycle.executedQty || 0),
    requestedPrice: Number(body.requestedPrice || 0),
    avgFillPrice: Number(lifecycle.avgFillPrice || 0),
    rejectProbability: Number(executionProfile.config?.execution?.rejectProbability || 0),
    executionStress: Number(executionProfile.stress || 0),
    edgeScore: 1,
    sizingMultiplier: 1
  });
  flushExecutionTelemetry();

  let trade = null;
  const shouldCloseNow = typeof body.exitPrice === "number";

  const next = withState((s) => {
    let draft = {
      ...s,
      orders: [...s.orders, lifecycle.order],
      fills: [...s.fills, ...lifecycle.fills]
    };

    if (!lifecycle.rejected && lifecycle.executedQty > 0) {
      if (shouldCloseNow) {
        const entryTime = new Date().toISOString();
        const exitTime = new Date().toISOString();
        const holdingSeconds = 1;
        const netPnlJpy = calculateNetPnlJpy(side, lifecycle.avgFillPrice, Number(body.exitPrice), lifecycle.executedQty, lifecycle.feeJpy);
        trade = {
          id: randomUUID(),
          symbol: "USDJPY",
          side,
          entryPrice: lifecycle.avgFillPrice,
          exitPrice: Number(body.exitPrice),
          qty: lifecycle.executedQty,
          entryTime,
          exitTime,
          holdingSeconds,
          netPnlJpy,
          assistantAdopted: Boolean(body.assistantAdopted),
          slippagePips: lifecycle.slippagePips,
          latencyMs: lifecycle.latencyMs,
          feeJpy: lifecycle.feeJpy,
          executionSession: executionProfile.session,
          executionStress: executionProfile.stress,
          executionMode,
          exitReason: "execution-sim",
          regime: body.regime || null,
          linkedEventIds: Array.isArray(body.linkedEventIds) ? body.linkedEventIds : [],
          eventFeatureSnapshot: body.eventFeatureSnapshot || null,
          eventDominantTag: body.eventDominantTag || null,
          createdAt: new Date().toISOString()
        };

        const currentBalanceJpy = Number((draft.account.currentBalanceJpy + trade.netPnlJpy).toFixed(2));
        const dayPnlJpy = Number((draft.account.dayPnlJpy + trade.netPnlJpy).toFixed(2));
        const weekDrawdownJpy = dayPnlJpy < 0 ? Math.abs(dayPnlJpy) : 0;

        draft = {
          ...draft,
          account: {
            ...draft.account,
            currentBalanceJpy,
            dayPnlJpy,
            weekDrawdownJpy,
            consecutiveLosses: updateConsecutiveLosses(draft.account.consecutiveLosses, trade.netPnlJpy)
          },
          trades: [...draft.trades, trade]
        };
      } else {
        const position = {
          id: randomUUID(),
          side: side === "BUY" ? "LONG" : "SHORT",
          qty: lifecycle.executedQty,
          entryPrice: lifecycle.avgFillPrice,
          openedAt: new Date().toISOString(),
          executionMode,
          status: "OPEN",
          orderId: lifecycle.order.id
        };
        draft = {
          ...draft,
          positions: [...draft.positions, position]
        };
      }
    }

    return appendAudit(draft, "order.executed", {
      orderId: lifecycle.order.id,
      status: lifecycle.order.status,
      latencyMs: lifecycle.latencyMs,
      slippagePips: lifecycle.slippagePips,
      executionSession: executionProfile.session,
      executionStress: executionProfile.stress,
      rejected: lifecycle.rejected,
      fillCount: lifecycle.fills.length
    });
  });

  send(res, 201, {
    order: lifecycle.order,
    fills: lifecycle.fills,
    trade,
    account: next.account
  });
}

function runAutoTraderTick() {
  const processTiming = createAutoProcessTiming();
  try {
    const state = loadState();
    const marketTick = market.step();
    const marketStatus = market.getMarketStatus();
    let stopRequested = Boolean(state.settings.autoStopRequested);
    const closeResult = closeAutoPositions(state, marketTick, { forceCloseAll: false, stopRequested });
    const working = closeResult.changed ? withState(() => closeResult.state) : state;

    if (closeResult.closedCount > 0) {
      autoRuntime.lastAction = `CLOSE:${closeResult.closedCount}`;
    }
    if (!working.settings.autoModeEnabled) return;
    if (!marketStatus.fxOpen) {
      autoRuntime.lastAction = "HOLD";
      autoRuntime.lastSkipReason = "市場クローズ中（土日）";
      return;
    }
    if (!marketStatus.realtime) {
      autoRuntime.lastAction = "HOLD";
      autoRuntime.lastSkipReason = `リアルタイム未接続 (${marketStatus.source})`;
      return;
    }
    const hasOpen = hasOpenAutoPosition(working.positions);
    if (stopRequested) {
    if (!hasOpen) {
      withState((s) => appendAudit({
        ...s,
        settings: {
          ...s.settings,
          autoModeEnabled: false,
          autoStopRequested: false
        }
      }, "auto.mode.changed", { enabled: false, reason: "stop-request-settled" }));
      autoRuntime.enabledSince = null;
      autoRuntime.lastAction = "STOP_OPTIMAL";
      autoRuntime.lastSkipReason = "停止要求の最適決済完了";
      return;
    }
    autoRuntime.lastAction = "STOP_PENDING";
    autoRuntime.lastSkipReason = "停止要求のため新規エントリー停止";
    return;
  }
    runLearningOps(working);
    const killSwitch = evaluateKillSwitch({
    state: working,
    cfg: RUNTIME_CONFIG.auto?.killSwitch || {}
  });
    autoRuntime.lastKillSwitch = killSwitch;
    const rollingExpectancy = evaluateRollingExpectancy({
    trades: working.trades || [],
    memory: autoRuntime.learningMemory,
    cfg: RUNTIME_CONFIG.auto?.rollingExpectancy || {}
  });
    autoRuntime.lastRollingExpectancy = rollingExpectancy;
    if (killSwitch.shouldStop || rollingExpectancy.shouldStop) {
    const reason = killSwitch.shouldStop ? killSwitch.reason : rollingExpectancy.reason;
    withState((s) => appendAudit({
      ...s,
      settings: {
        ...s.settings,
        autoModeEnabled: true,
        autoStopRequested: true
      }
    }, "auto.killswitch.stop", {
      reason,
      killSwitch,
      rollingExpectancy
    }));
    autoRuntime.lastAction = "STOP_PENDING";
    autoRuntime.lastSkipReason = reason;
    stopRequested = true;
  }
    // P0: uptime-first rescue stage with short cooldown tiers.
    if (!stopRequested && rollingExpectancy.shouldRescue) {
      const stageCfg = Array.isArray(RUNTIME_CONFIG.auto?.rollingExpectancy?.rescueStages)
        ? RUNTIME_CONFIG.auto.rollingExpectancy.rescueStages
        : [];
      const breakdown = Math.max(1, Number(rollingExpectancy.consecutiveBreakdown || 1));
      const pickedStage = stageCfg
        .map((x) => ({
          breakdown: Math.max(1, Number(x?.breakdown || 1)),
          cooldownSec: Math.max(60, Number(x?.cooldownSec || rollingExpectancy.rescueCooldownSec || 300)),
          riskMultiplier: clamp(Number(x?.riskMultiplier || rollingExpectancy.riskMultiplier || 0.25), 0.03, 1)
        }))
        .sort((a, b) => a.breakdown - b.breakdown)
        .find((x) => breakdown <= x.breakdown)
        || {
          breakdown,
          cooldownSec: Math.max(60, Number(rollingExpectancy.rescueCooldownSec || 1200)),
          riskMultiplier: clamp(Number(rollingExpectancy.riskMultiplier || 0.15), 0.03, 1)
        };
      const cooldownSec = pickedStage.cooldownSec;
      autoRuntime.rollingRescueCooldownUntilMs = Date.now() + cooldownSec * 1000;
      autoRuntime.rollingRescueStage = pickedStage.breakdown;
      autoRuntime.rollingRescueReason = rollingExpectancy.reason;
      autoRuntime.lastSkipReason = `${rollingExpectancy.reason} (rescue cooldown ${cooldownSec}s)`;
      withState((s) => appendAudit(s, "auto.rolling.rescue", {
        reason: rollingExpectancy.reason,
        stage: pickedStage.breakdown,
        cooldownSec,
        riskMultiplier: pickedStage.riskMultiplier,
        expectancyR: Number(rollingExpectancy.expectancyR || 0),
        profitFactor: Number(rollingExpectancy.profitFactor || 0)
      }));
    }
    if (!rollingExpectancy.shouldRescue) autoRuntime.rollingRescueStage = 0;
    if (!stopRequested && rollingExpectancy.shouldThrottle) {
      autoRuntime.lastSkipReason = rollingExpectancy.reason;
    }
    markAutoProcessTiming(processTiming, "baseCheckedNs");
  if (!stopRequested && killSwitch.shouldThrottle) {
    autoRuntime.lastSkipReason = killSwitch.reason;
  }
  if (stopRequested) {
    autoRuntime.lastAction = "STOP_PENDING";
    autoRuntime.lastSkipReason = autoRuntime.lastSkipReason || "停止要求のため新規エントリー停止";
    return;
  }
  if (hasOpen) return;
  const now = Date.now();
  if (now < Number(autoRuntime.rollingRescueCooldownUntilMs || 0)) {
    autoRuntime.lastAction = "COOLDOWN";
    autoRuntime.lastSkipReason = autoRuntime.rollingRescueReason || "rolling rescue cooldown";
    return;
  }
  autoRuntime.rollingRescueCooldownUntilMs = 0;
  autoRuntime.rollingRescueReason = null;
  const cooldownEnabled = Boolean(RUNTIME_CONFIG.auto?.entryCooldown?.enabled);
  if (cooldownEnabled) {
    const cooldown = evaluateAutoEntryCooldown(working, now);
    if (cooldown.active) {
      if (cooldown.startedNow) {
        withState((s) => appendAudit(s, "auto.cooldown.enter", {
          reason: cooldown.reason,
          cooldownSec: cooldown.cooldownSec,
          lossesInWindow: cooldown.lossesInWindow,
          sampleTrades: cooldown.sampleTrades
        }));
      }
      autoRuntime.lastAction = `COOLDOWN:${cooldown.remainingSec}s`;
      autoRuntime.lastSkipReason = cooldown.reason;
      return;
    }
    if (cooldown.clearedNow) {
      withState((s) => appendAudit(s, "auto.cooldown.exit", {
        reason: autoRuntime.cooldownReason || "elapsed"
      }));
      autoRuntime.cooldownReason = null;
    }
  } else {
    autoRuntime.cooldownUntilMs = 0;
    autoRuntime.cooldownReason = null;
  }

  const intervalMs = normalizeAutoSec(working.settings.autoIntervalSec, 0.1, 3600) * 1000;
  if (now - autoRuntime.lastRunMs < intervalMs) return;
  autoRuntime.lastRunMs = now;
  autoRuntime.lastRunAt = new Date(now).toISOString();
  const executionTailGate = evaluateExecutionTailGate(now);
  autoRuntime.lastExecutionTailGate = executionTailGate;
  if (executionTailGate.blocked) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = executionTailGate.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "execution tail gate",
      detail: executionTailGate.reason,
      mode: executionTailGate.mode || "UNKNOWN",
      sampleSize: Number(executionTailGate?.stats?.sampleSize || 0),
      avgPipelineLatencyMs: Number(executionTailGate?.stats?.avgPipelineLatencyMs || 0),
      p95PipelineLatencyMs: Number(executionTailGate?.stats?.p95PipelineLatencyMs || 0),
      p99PipelineLatencyMs: Number(executionTailGate?.stats?.p99PipelineLatencyMs || 0),
      rejectRate: Number(executionTailGate?.stats?.rejectRate || 0),
      p95SlippagePips: Number(executionTailGate?.stats?.p95SlippagePips || 0),
      tailPenaltyMultiplier: Number(executionTailGate?.tailPenaltyMultiplier || 1)
    }));
    return;
  }

  const sharedSets = market.getDecisionCandles();
  const generated = generateSignalFromState(
    working,
    Number(working.settings.autoRiskPercentPerTrade || working.settings.maxRiskPercentPerTrade),
    {
      signalProfile: shadowLearningRuntime.approvedProfile || "BASELINE",
      ticker: marketTick,
      sets: sharedSets
    }
  );
  const ticker = generated.ticker;
  const confidenceCalibration = buildConfidenceCalibration({
    trades: working.trades || [],
    cfg: RUNTIME_CONFIG.confidenceCalibration || {}
  });
  autoRuntime.lastConfidenceCalibration = confidenceCalibration;
  const signal = calibrateSignalConfidence(generated.signal, confidenceCalibration);
  const reentryGuard = evaluateAutoReentryGuard({
    state: working,
    signal,
    ticker,
    sets: sharedSets,
    nowMs: now
  });
  autoRuntime.lastReentryGuard = reentryGuard;
  if (reentryGuard.blocked) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = reentryGuard.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "reentry guard",
      detail: reentryGuard.reason,
      reasonCode: reentryGuard.reasonCode,
      elapsedSec: reentryGuard.elapsedSec,
      minCooldownSec: reentryGuard.minCooldownSec,
      cooldownRemainingSec: reentryGuard.cooldownRemainingSec,
      minPullbackPips: reentryGuard.minPullbackPips,
      pullbackPips: reentryGuard.pullbackPips,
      lastExitReason: reentryGuard.lastExitReason,
      reentryDiagnostics: reentryGuard
    }));
    return;
  }
  const multiTimeframeDiagnostics = buildMultiTimeframeDiagnostics({
    sets: sharedSets,
    action: signal.action,
    regime: signal.regime
  });
  let entryLocationDiagnostics = buildEntryLocationDiagnostics({
    signal,
    sets: sharedSets,
    ticker,
    mtf: multiTimeframeDiagnostics
  });
  let entryEvidenceDiagnostics = buildEntryEvidenceDiagnostics({
    signal,
    preTradeGuard: { allowed: true, edgeAfterBuffer: signal?.metrics?.expectedValuePips || 0, spreadPips: ticker.spreadPips, spreadGatePips: 0.8 },
    contextValidation: { allowed: true },
    executionTailGate,
    mtf: multiTimeframeDiagnostics,
    entryLocation: entryLocationDiagnostics
  });
  autoRuntime.lastMultiTimeframeDiagnostics = multiTimeframeDiagnostics;
  autoRuntime.lastEntryLocationDiagnostics = entryLocationDiagnostics;
  autoRuntime.lastTrendUpEntryQuality = entryLocationDiagnostics;
  autoRuntime.lastEntryEvidenceBreakdown = entryEvidenceDiagnostics.entryEvidenceBreakdown;
  const noTradeZone = evaluateNoTradeZone({
    ticker,
    signal,
    nowMs: now
  });
  autoRuntime.lastNoTradeZone = noTradeZone;
  if (noTradeZone.blocked) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = noTradeZone.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "no-trade zone",
      reasonCode: noTradeZone.reasonCode || "UNKNOWN",
      detail: noTradeZone.reason
    }));
    return;
  }
  const ensembleCandidates = listShadowProfiles(RUNTIME_CONFIG.shadowAB || {})
    .slice(0, 4)
    .map((profile) => generateSignalFromState(
      working,
      Number(working.settings.autoRiskPercentPerTrade || working.settings.maxRiskPercentPerTrade),
      {
        signalProfile: profile,
        ticker,
        sets: sharedSets
      }
    ))
    .map((x) => ({ profile: x.signal.signalProfile || "BASELINE", signal: x.signal }));
  const ensembleGate = evaluateEnsembleGate({
    primarySignal: signal,
    candidates: ensembleCandidates,
    cfg: RUNTIME_CONFIG.ensembleGate || {}
  });
  autoRuntime.lastEnsembleGate = ensembleGate;
  if (!ensembleGate.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = ensembleGate.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "ensemble gate",
      detail: ensembleGate.reason,
      score: ensembleGate.score,
      agreementRatio: ensembleGate.agreementRatio,
      actionableRatio: ensembleGate.actionableRatio
    }));
    return;
  }
  const rawBanditDecision = decideBanditGuard({
    signal,
    ticker,
    config: RUNTIME_CONFIG
  });
  const banditObservationMode = Boolean(RUNTIME_CONFIG.rlBandit?.observationMode);
  const banditDecision = banditObservationMode
    ? {
      ...rawBanditDecision,
      guardHold: false,
      sizeMultiplier: 1,
      selectedAction: signal.action,
      reason: `${rawBanditDecision.reason || "bandit"}:observation-mode`
    }
    : rawBanditDecision;
  const objective = computeObjectiveScore({
    summary: analyticsSummary((working.trades || []).slice(-120)),
    avgCostJpy: (() => {
      const recent = (working.trades || []).slice(-120);
      if (!recent.length) return 0;
      return recent.reduce((s, t) => s + Math.max(0, Number(t.feeJpy || 0)), 0) / recent.length;
    })(),
    cfg: RUNTIME_CONFIG.objective || {}
  });
  autoRuntime.lastObjective = objective;
  autoRuntime.lastSignalRationale = signal.rationale || null;
  const anomaly = evaluateAnomalyControl(working, ticker);
  autoRuntime.anomalyMode = anomaly.mode;
  if (anomaly.blocked) {
    const reasonChanged = autoRuntime.lastSkipReason !== anomaly.reason || autoRuntime.lastAction !== "HOLD";
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = anomaly.reason;
    if (reasonChanged) {
      withState((s) => appendAudit(s, "auto.anomaly.block", anomaly));
    }
    return;
  }
  const benchmarkGate = evaluateBenchmarkGate(working);
  if (!benchmarkGate.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = benchmarkGate.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "benchmark gate",
      detail: benchmarkGate.reason
    }));
    return;
  }
  const walkForwardGate = evaluateWalkForwardGate(working.trades || [], RUNTIME_CONFIG.walkForwardGate || {});
  autoRuntime.lastWalkForwardGate = walkForwardGate;
  if (!walkForwardGate.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = walkForwardGate.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "walk-forward gate",
      detail: walkForwardGate.reason,
      pending: Boolean(walkForwardGate.pending),
      sampleSize: Number(walkForwardGate.sampleSize || 0)
    }));
    return;
  }
  const expectancyGate = evaluateExpectancyGate(
    working.trades || [],
    RUNTIME_CONFIG.auto?.expectancyGate || {},
    autoRuntime.learningMemory
  );
  autoRuntime.lastExpectancyGate = expectancyGate;
  if (!expectancyGate.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = expectancyGate.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "expectancy gate",
      detail: expectancyGate.reason,
      pending: Boolean(expectancyGate.pending),
      source: expectancyGate.source || "recent",
      sampleSize: Number(expectancyGate.sampleSize || 0),
      memorySampleSize: Number(expectancyGate.memorySampleSize || 0)
    }));
    return;
  }
  const degradationGuard = evaluateDegradationGuard({
    trades: working.trades || [],
    memory: autoRuntime.learningMemory,
    cfg: RUNTIME_CONFIG.degradationGuard || {}
  });
  autoRuntime.lastDegradationGuard = degradationGuard;
  if (!degradationGuard.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = degradationGuard.reason;
    withState((s) => appendAudit(s, "auto.degradation.block", {
      mode: degradationGuard.mode,
      reason: degradationGuard.reason
    }));
    return;
  }
  const metaGate = evaluateMetaGate({
    benchmarkAllowed: benchmarkGate.allowed,
    walkForwardAllowed: walkForwardGate.allowed,
    walkForwardPending: walkForwardGate.pending,
    expectancyAllowed: expectancyGate.allowed,
    expectancyPending: expectancyGate.pending,
    anomalyBlocked: anomaly.blocked,
    banditAdvantage: banditDecision.advantage,
    banditGuardHold: banditDecision.guardHold,
    objectiveNormalizedScore: objective.normalized
  }, RUNTIME_CONFIG.metaGate || {});
  autoRuntime.lastMetaGate = metaGate;
  if (!metaGate.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = metaGate.reason;
    return;
  }
  markAutoProcessTiming(processTiming, "decisionReadyNs");
  withState((s) => appendAudit({
    ...s,
    assistantSignals: [...s.assistantSignals.slice(-499), { ...signal, source: "auto-mode" }]
  }, "auto.signal.generated", {
    signalId: signal.id,
    action: signal.action,
    bandit: banditDecision,
    banditRaw: rawBanditDecision,
    banditObservationMode
  }));

  if (signal.action === "HOLD" || !(signal.positionSize > 0)) {
    const noActionableSignalDiagnostics = buildNoActionableSignalDiagnostics({
      signal,
      sets: sharedSets,
      mtf: multiTimeframeDiagnostics,
      entryLocation: entryLocationDiagnostics,
      evidence: entryEvidenceDiagnostics
    });
    const decisionTrace = buildDecisionTrace({
      signal,
      finalAction: "HOLD",
      finalReason: signal.rationale || "no actionable signal",
      mtf: multiTimeframeDiagnostics,
      evidence: entryEvidenceDiagnostics,
      entryLocation: entryLocationDiagnostics,
      preTradeGuard: { allowed: true },
      reentryGuard,
      executionTailGate
    });
    autoRuntime.lastNoActionableSignalDiagnostics = noActionableSignalDiagnostics;
    autoRuntime.lastDecisionTrace = decisionTrace;
    autoRuntime.banditGuardHoldStreak = 0;
    autoRuntime.banditGuardStreakStartedMs = 0;
    autoRuntime.banditGuardLastContext = null;
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = signal.rationale || "no actionable signal";
    autoRuntime.lastSizing = null;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "no actionable signal",
      blockedStage: "signal_generation",
      noActionableSignalDiagnostics,
      decisionTrace
    }));
    return;
  }
  const banditBypassCfg = RUNTIME_CONFIG.rlBandit?.guardBypass || {};
  const guardBypassEnabled = Boolean(banditBypassCfg.enabled);
  const maxConsecutiveHolds = Math.max(1, Number(banditBypassCfg.maxConsecutiveHolds || 120));
  const maxGuardHoldSec = Math.max(1, Number(banditBypassCfg.maxHoldSec || 30));
  let banditGuardBypassed = false;
  if (banditDecision.guardHold) {
    const contextKey = String(banditDecision.contextKey || "");
    const sameContext = autoRuntime.banditGuardLastContext === contextKey;
    if (!sameContext) {
      autoRuntime.banditGuardHoldStreak = 0;
      autoRuntime.banditGuardStreakStartedMs = now;
    }
    autoRuntime.banditGuardLastContext = contextKey || null;
    autoRuntime.banditGuardHoldStreak += 1;
    if (!autoRuntime.banditGuardStreakStartedMs) {
      autoRuntime.banditGuardStreakStartedMs = now;
    }
    const streakSec = Math.max(0, (now - Number(autoRuntime.banditGuardStreakStartedMs || now)) / 1000);
    if (guardBypassEnabled
      && (autoRuntime.banditGuardHoldStreak >= maxConsecutiveHolds || streakSec >= maxGuardHoldSec)) {
      banditGuardBypassed = true;
      autoRuntime.banditGuardBypassCount += 1;
      withState((s) => appendAudit(s, "auto.bandit.guard.bypass", {
        contextKey,
        holdStreak: autoRuntime.banditGuardHoldStreak,
        streakSec: Number(streakSec.toFixed(2)),
        maxConsecutiveHolds,
        maxHoldSec: maxGuardHoldSec,
        holdScore: banditDecision.holdScore,
        actionScore: banditDecision.actionScore
      }));
      autoRuntime.banditGuardHoldStreak = 0;
      autoRuntime.banditGuardStreakStartedMs = 0;
      autoRuntime.banditGuardLastContext = null;
    }
  } else {
    autoRuntime.banditGuardHoldStreak = 0;
    autoRuntime.banditGuardStreakStartedMs = 0;
    autoRuntime.banditGuardLastContext = null;
  }
  if (banditDecision.guardHold && !banditGuardBypassed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = `bandit guard (${banditDecision.contextKey || "-"}) streak=${autoRuntime.banditGuardHoldStreak}`;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "bandit guard hold",
      contextKey: banditDecision.contextKey,
      holdStreak: autoRuntime.banditGuardHoldStreak,
      holdScore: banditDecision.holdScore,
      actionScore: banditDecision.actionScore
    }));
    return;
  }
  const baseRiskPercent = clamp(
    Number(working.settings.autoRiskPercentPerTrade || working.settings.maxRiskPercentPerTrade || 1),
    1,
    100
  );
  const capitalAllocation = allocateRiskPercent({
    baseRiskPercent,
    account: working.account,
    trades: working.trades || [],
    cfg: RUNTIME_CONFIG.capitalAllocation || {},
    objectiveCfg: RUNTIME_CONFIG.objective || {}
  });
  autoRuntime.lastCapitalAllocation = capitalAllocation;
  const degradedRiskPercent = Number(capitalAllocation.riskPercent || baseRiskPercent)
    * Number(degradationGuard.riskMultiplier || 1);
  let selectedRiskPercent = clamp(
    degradedRiskPercent
    * Number(rollingExpectancy.riskMultiplier || 1)
    * Number(killSwitch.riskMultiplier || 1),
    0.1,
    100
  );
  // P0: startup learning phase keeps minimum risk to avoid too-small trade sizes and data starvation.
  const startupRiskCfg = RUNTIME_CONFIG.auto?.startupRiskRelax || {};
  if (Boolean(startupRiskCfg.enabled)) {
    const autoTradesCount = (Array.isArray(working.trades) ? working.trades : [])
      .filter((t) => String(t?.source || "").toLowerCase() === "auto")
      .length;
    const maxTrades = Math.max(0, Number(startupRiskCfg.maxTrades || 200));
    if (autoTradesCount < maxTrades) {
      const minRiskFraction = clamp(Number(startupRiskCfg.minRiskFractionOfBase || 0.7), 0.1, 1);
      const startupMinRiskPercent = clamp(baseRiskPercent * minRiskFraction, 0.1, 100);
      selectedRiskPercent = Math.max(selectedRiskPercent, startupMinRiskPercent);
    }
  }
  const shadowTrades = Object.values(shadowLearningRuntime.tradesByProfile || {}).flatMap((v) => (Array.isArray(v) ? v : []));
  const contextValidation = evaluateContextValidation({
    contextKey: banditDecision.contextKey,
    signal,
    ticker,
    selectedRiskPercent,
    liveTrades: working.trades || [],
    shadowTrades,
    bootstrapContextCounts: {
      ...(BOOTSTRAP_CONTEXT_COUNTS || {}),
      ...((autoRuntime.learningMemory && autoRuntime.learningMemory.contextCounts) ? autoRuntime.learningMemory.contextCounts : {})
    },
    cfg: RUNTIME_CONFIG.contextValidation || {}
  });
  autoRuntime.lastContextValidation = contextValidation;
  const currentExecMode = normalizeAutoExecutionMode(loadState().settings?.autoExecutionMode);
  const isStrongBase = entryEvidenceDiagnostics?.entryEvidenceBreakdown?.finalCategory === "STRONG_BASE";
  const evidenceScore = Number(entryEvidenceDiagnostics?.entryEvidenceScore || 0);
  const isPaperLive = currentExecMode === "PAPER_LIVE" || currentExecMode === "PAPER";

  if (!contextValidation.allowed) {
    contextValidation.originalReason = contextValidation.reason;
    contextValidation.finalCategory = entryEvidenceDiagnostics?.entryEvidenceBreakdown?.finalCategory;
    contextValidation.entryEvidenceScore = evidenceScore;

    let bypassMode = "BLOCK";
    if (isStrongBase && evidenceScore >= 0.80 && isPaperLive) {
      bypassMode = "WARN_ONLY";
    }

    if (bypassMode === "BLOCK") {
      let skipMessage = `validation-only: ${contextValidation.reason}`;
      if (contextValidation.reason === "unvalidated context") {
        skipMessage = "未検証の相場コンテキストのため検証モードで停止";
      } else if (contextValidation.reason === "context key missing") {
        skipMessage = "コンテキストキーがありません";
      }
      
      contextValidation.appliedMode = "BLOCK";
      contextValidation.reason = skipMessage;
      autoRuntime.lastAction = "HOLD";
      autoRuntime.lastSkipReason = skipMessage;
      
      const blockedDecisionTrace = buildDecisionTrace({
        signal,
        finalAction: "HOLD",
        finalReason: skipMessage,
        mtf: multiTimeframeDiagnostics,
        evidence: entryEvidenceDiagnostics,
        entryLocation: entryLocationDiagnostics,
        preTradeGuard: { allowed: true, reason: skipMessage },
        reentryGuard: {},
        executionTailGate: {},
        positionSizingDiagnostics: {}
      });
      blockedDecisionTrace.stages.push({
        name: "context_validation",
        status: "blocked",
        details: contextValidation
      });
      blockedDecisionTrace.price = positiveNum(signal.entryPrice, positiveNum(entryLocationDiagnostics.currentPrice, 0));
      autoRuntime.lastDecisionTrace = blockedDecisionTrace;

      const noActionableSignalDiagnostics = buildNoActionableSignalDiagnostics({
        signal,
        sets: sharedSets,
        mtf: multiTimeframeDiagnostics,
        entryLocation: entryLocationDiagnostics,
        evidence: entryEvidenceDiagnostics
      });
      noActionableSignalDiagnostics.category = "CONTEXT_UNVALIDATED";
      noActionableSignalDiagnostics.reason = skipMessage;
      autoRuntime.lastNoActionableSignalDiagnostics = noActionableSignalDiagnostics;

      withState((s) => appendAudit(s, "auto.skip", {
        reason: "context validation",
        contextKey: banditDecision.contextKey,
        validationMode: contextValidation.mode,
        exactCount: contextValidation.exactCount,
        coarseCount: contextValidation.coarseCount,
        appliedMode: "BLOCK"
      }));
      return;
    } else {
      contextValidation.appliedMode = "WARN_ONLY";
      contextValidation.allowed = true;
      contextValidation.reason = "未検証コンテキストですが、STRONG_BASE・高スコアかつ非LIVE環境のためwarn-onlyとして通過します";
    }
  } else {
    contextValidation.appliedMode = "PASS";
    contextValidation.originalReason = contextValidation.reason;
    contextValidation.finalCategory = entryEvidenceDiagnostics?.entryEvidenceBreakdown?.finalCategory;
    contextValidation.entryEvidenceScore = evidenceScore;
  }
  const executionProfile = buildExecutionConfig(getRuntimeExecutionConfig(), {
    ...ticker,
    news: signal.news || null
  });
  const preTradeGuard = evaluatePreTradeGuard({
    signal,
    ticker,
    executionProfile,
    contextValidation,
    degradationGuard,
    spreadStats: buildPreTradeSpreadStats(executionTailGate?.stats),
    httpProvider: String(process.env.MARKET_HTTP_PROVIDER || ""),
    marketSource: String(marketStatus?.source || ""),
    marketInputMode: String(marketStatus?.inputMode || ""),
    marketRealtime: Boolean(marketStatus?.realtime),
    entryLocationDiagnostics,
    cfg: RUNTIME_CONFIG.preTradeGuard || {}
  });
  autoRuntime.lastPreTradeGuard = preTradeGuard;
  const preTradeEntryRefPrice = Number(signal.entryPrice || (signal.action === "BUY" ? ticker.ask : ticker.bid) || 0);
  autoRuntime.lastPositionSizingDiagnostics = buildPositionSizingDiagnostics({
    state: working,
    signal,
    price: preTradeEntryRefPrice
  });
  if (!preTradeGuard.allowed) {
    // Generate latest diagnostics for blocked state
    const blockedEntryLocationDiagnostics = buildEntryLocationDiagnostics({
      signal,
      sets: sharedSets,
      ticker,
      mtf: multiTimeframeDiagnostics
    });
    const blockedEntryEvidenceDiagnostics = buildEntryEvidenceDiagnostics({
      signal,
      preTradeGuard,
      contextValidation,
      executionTailGate,
      mtf: multiTimeframeDiagnostics,
      entryLocation: blockedEntryLocationDiagnostics
    });
    const blockedDecisionTrace = buildDecisionTrace({
      signal,
      finalAction: "HOLD",
      finalReason: preTradeGuard.reason || "pre-trade guard blocked",
      mtf: multiTimeframeDiagnostics,
      evidence: blockedEntryEvidenceDiagnostics,
      entryLocation: blockedEntryLocationDiagnostics,
      preTradeGuard,
      reentryGuard,
      executionTailGate
    });
    const blockedNoActionableSignalDiagnostics = buildNoActionableSignalDiagnostics({
      signal,
      sets: sharedSets,
      mtf: multiTimeframeDiagnostics,
      entryLocation: blockedEntryLocationDiagnostics,
      evidence: blockedEntryEvidenceDiagnostics
    });
    autoRuntime.lastDecisionTrace = blockedDecisionTrace;
    autoRuntime.lastEntryLocationDiagnostics = blockedEntryLocationDiagnostics;
    autoRuntime.lastEntryEvidenceBreakdown = blockedEntryEvidenceDiagnostics.entryEvidenceBreakdown;
    autoRuntime.lastNoActionableSignalDiagnostics = blockedNoActionableSignalDiagnostics;
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = signal.rationale
      ? `${preTradeGuard.reason}; candidate: ${signal.rationale}`
      : preTradeGuard.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "pre-trade guard",
      detail: preTradeGuard.reason,
      confidence: preTradeGuard.confidence,
      confidenceFloor: preTradeGuard.confidenceFloor,
      edgeAfterBuffer: preTradeGuard.edgeAfterBuffer,
      spreadPips: preTradeGuard.spreadPips,
      executionStress: preTradeGuard.executionStress,
      positionSizingDiagnostics: autoRuntime.lastPositionSizingDiagnostics,
      decisionTrace: blockedDecisionTrace,
      entryLocationDiagnostics: blockedEntryLocationDiagnostics,
      entryEvidenceBreakdown: blockedEntryEvidenceDiagnostics.entryEvidenceBreakdown
    }));
    return;
  }
  entryLocationDiagnostics = buildEntryLocationDiagnostics({
    signal,
    sets: sharedSets,
    ticker,
    mtf: multiTimeframeDiagnostics
  });
  entryEvidenceDiagnostics = buildEntryEvidenceDiagnostics({
    signal,
    preTradeGuard,
    contextValidation,
    executionTailGate,
    mtf: multiTimeframeDiagnostics,
    entryLocation: entryLocationDiagnostics
  });
  const entryEvidenceScore = Number(entryEvidenceDiagnostics.entryEvidenceScore || 0);
  const entryLocationScore = Number(entryLocationDiagnostics.entryLocationScore || 0);
  const trendUpEntryQuality = {
    entryTimingCategory: entryLocationDiagnostics.entryLocationCategory,
    overextendedAtEntry: Boolean(entryLocationDiagnostics.overextendedEntry),
    pullbackConfirmed: Boolean(entryLocationDiagnostics.pullbackConfirmed),
    validPullbackConfirmed: Boolean(entryLocationDiagnostics.validPullbackConfirmed),
    recentRunupPips: entryLocationDiagnostics.recentRunupPips,
    distanceFromRecentHighPips: entryLocationDiagnostics.distanceFromRecentHighPips,
    entryAfterRunupBars: entryLocationDiagnostics.recentRunupBars,
    entryDelayRisk: Boolean(entryLocationDiagnostics.lateEntryDetected),
    earlyAdverseMoveDetected: false
  };
  const lateEntryDiagnostics = {
    lateEntryDetected: Boolean(entryLocationDiagnostics.lateEntryDetected),
    recentRunupPips: entryLocationDiagnostics.recentRunupPips,
    recentRunupBars: entryLocationDiagnostics.recentRunupBars,
    distanceFromRecentHighPips: entryLocationDiagnostics.distanceFromRecentHighPips,
    rsi1m: entryLocationDiagnostics.rsi1m,
    bbZ1m: entryLocationDiagnostics.bbZ1m,
    rsi5m: entryLocationDiagnostics.rsi5m,
    bbZ5m: entryLocationDiagnostics.bbZ5m,
    reason: entryLocationDiagnostics.reason
  };
  const lowEvidenceBlock = entryEvidenceScore < 0.45 || Number(entryLocationDiagnostics.upsideDownsideRatio || 0) < 0.8;
  const probeLowRateApplied = Boolean(
    reentryGuard.downgradedToProbeLowRate
    || entryEvidenceDiagnostics.probeLowRateEligible
    || (entryEvidenceScore >= 0.60 && entryEvidenceScore < 0.75)
    || (entryLocationDiagnostics.lateEntryDetected && entryEvidenceScore >= 0.60)
  );
  autoRuntime.lastEntryLocationDiagnostics = entryLocationDiagnostics;
  autoRuntime.lastEntryEvidenceBreakdown = entryEvidenceDiagnostics.entryEvidenceBreakdown;
  autoRuntime.lastTrendUpEntryQuality = trendUpEntryQuality;
  if (lowEvidenceBlock && !probeLowRateApplied) {
    const decisionTrace = buildDecisionTrace({
      signal,
      finalAction: "HOLD",
      finalReason: "entry evidence weak",
      mtf: multiTimeframeDiagnostics,
      evidence: entryEvidenceDiagnostics,
      entryLocation: entryLocationDiagnostics,
      preTradeGuard,
      reentryGuard,
      executionTailGate
    });
    autoRuntime.lastDecisionTrace = decisionTrace;
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = signal.rationale
      ? `根拠スコア不足; candidate: ${signal.rationale}`
      : "根拠スコア不足";
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "entry evidence weak",
      blockedStage: "entry_evidence",
      entryEvidenceScore,
      entryEvidenceBreakdown: entryEvidenceDiagnostics.entryEvidenceBreakdown,
      entryLocationDiagnostics,
      decisionTrace
    }));
    return;
  }
  const patternQuality = evaluatePatternQualityGate({
    signal,
    trades: working.trades || [],
    cfg: RUNTIME_CONFIG.patternQualityGate || {}
  });
  autoRuntime.lastPatternQualityGate = patternQuality;
  if (!patternQuality.allowed && Boolean(RUNTIME_CONFIG.patternQualityGate?.enforce)) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = patternQuality.reason;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "pattern quality",
      detail: patternQuality.reason,
      score: patternQuality.score,
      minScore: patternQuality.minScore,
      distanceToWins: patternQuality.distanceToWins,
      distanceToLosses: patternQuality.distanceToLosses
    }));
    return;
  }
  const minQty = Math.max(1, Number(working.settings.minUnits || RUNTIME_CONFIG.positionSizing?.minUnits || RUNTIME_CONFIG.execution.minOrderQty || 1));
  const depthMaxQty = Math.max(minQty, Number(RUNTIME_CONFIG.execution.depthBaseQty || 40000) * 3);
  const entryRefPrice = Number(signal.entryPrice || (signal.action === "BUY" ? ticker.ask : ticker.bid) || 0);
  const executionMode = normalizeExecutionModeInput(working.settings.autoExecutionMode, "PAPER_LIVE");
  const riskCapitalJpy = getRiskCapitalJpy(working, executionMode);
  const maxQty = Math.max(minQty, Math.min(depthMaxQty, Number(working.settings.maxUnits || RUNTIME_CONFIG.positionSizing?.maxUnits || 50000)));
  const banditSizeMultiplier = Number(banditDecision.sizeMultiplier || 1);
  const anomalySizeMultiplier = Number(anomaly.sizeMultiplier || 1);
  const sizing = optimizePositionSize({
    signal,
    trades: working.trades || [],
    cfg: RUNTIME_CONFIG.sizing || {},
    objectiveCfg: RUNTIME_CONFIG.objective || {}
  });
  autoRuntime.lastSizing = sizing;
  const sizingMultiplier = Number(sizing.sizeMultiplier || 1);
  const validationSizeMultiplier = Number(contextValidation.sizeMultiplier || 1);
  const ensembleSizeMultiplier = Number(ensembleGate.sizeMultiplier || 1);
  const patternSizeMultiplier = Number(patternQuality.sizeMultiplier || 1);
  const preTradeSizeMultiplier = Number(preTradeGuard.sizeMultiplier || 1);
  const noTradeZoneSizeMultiplier = Number(noTradeZone?.sizeMultiplier || 1);
  const edgeCfg = RUNTIME_CONFIG.auto?.edgeSizing || {};
  const tailStats = executionTailGate?.stats || {};
  const targetSlip = Math.max(0.05, Number(RUNTIME_CONFIG.executionCalibration?.targetSlippagePips || 0.28));
  const p95Slip = Math.max(0.01, Number(tailStats.p95SlippagePips || targetSlip));
  const p95LatencyMs = Number(tailStats.p95PipelineLatencyMs || 0);
  const brokerAvgLatencyMs = Math.max(60, Number(RUNTIME_CONFIG.brokerMeta?.avgLatencyMs || RUNTIME_CONFIG.execution?.baseLatencyMs || 220));
  const brokerJitterMs = Math.max(20, Number(RUNTIME_CONFIG.execution?.latencyJitterMs || 120));
  const dynamicLatencyRefMs = Math.max(
    420,
    Number(edgeCfg.executionQualityP95LatencyRefMs || 0),
    Math.round(brokerAvgLatencyMs * 2 + brokerJitterMs * 1.2)
  );
  const dynamicLatencySoftCapMs = Math.max(
    dynamicLatencyRefMs + 120,
    Math.round(dynamicLatencyRefMs + brokerJitterMs * 1.8)
  );
  const regimeConfidence = clamp(Number(signal.confidence || 0), 0.2, 1);
  const ensembleAgreement = clamp(Number(ensembleGate.agreementRatio || ensembleGate.score || 0.6), 0.25, 1);
  const executionQualityScore = computeExecutionQualityScore({
    p95PipelineLatencyMs: p95LatencyMs,
    p95SlippagePips: p95Slip,
    rejectRate: Number(tailStats.rejectRate || 0),
    targetSlippagePips: targetSlip,
    p95LatencyRefMs: dynamicLatencyRefMs,
    rejectRateRef: Number(edgeCfg.executionQualityRejectRateRef || 0.04)
  });
  const nearTailThreshold = Number(tailStats.p95PipelineLatencyMs || 0) >= Number((RUNTIME_CONFIG.auto?.executionTailGate?.p95PipelineLatencyMsLimit || 900) * 0.9)
    || Number(tailStats.p95SlippagePips || 0) >= targetSlip * 2.2
    || Number(tailStats.rejectRate || 0) >= Number((RUNTIME_CONFIG.auto?.executionTailGate?.rejectRateLimit || 0.1) * 0.9);
  const microEdge = computeMicroEdgeScore({
    candles1m: sharedSets?.candles1m || [],
    action: signal.action,
    lookbackBars: Number(edgeCfg.microEdgeLookbackBars || 18)
  });
  const edgeResult = computeEdgeSizingMultiplier({
    regimeConfidence,
    ensembleAgreement,
    executionQualityScore,
    microEdge,
    nearTailThreshold,
    minMultiplier: Number(edgeCfg.minMultiplier || 0.5),
    maxMultiplier: Number(edgeCfg.maxMultiplier || 2)
  });
  const edgeScore = Number(edgeResult.edgeScore || 1);
  const latencySizingMultiplier = computeLatencySizingMultiplier({
    p95PipelineLatencyMs: p95LatencyMs,
    latencyRefMs: dynamicLatencyRefMs,
    latencySoftCapMs: dynamicLatencySoftCapMs,
    minMultiplier: Number(edgeCfg.latencyMinMultiplier || 0.65)
  });
  // P0: unified tail penalty replaces overlapping tail-aware blocks.
  const tailPenaltyMultiplier = computeTailPenaltyMultiplier({
    p95PipelineLatencyMs: Number(tailStats.p95PipelineLatencyMs || 0),
    p99PipelineLatencyMs: Number(tailStats.p99PipelineLatencyMs || 0),
    rejectRate: Number(tailStats.rejectRate || 0),
    p95SlippagePips: Number(tailStats.p95SlippagePips || 0),
    targetSlippagePips: targetSlip,
    cfg: RUNTIME_CONFIG.auto?.tailPenalty || {}
  });
  const modeCfg = RUNTIME_CONFIG.auto?.tradeMode || {};
  const baseMode = String(modeCfg.baseLabel || "BASE").toUpperCase();
  const semiMode = String(modeCfg.semiLabel || "SEMI").toUpperCase();
  const fullMode = String(modeCfg.fullLabel || "FULL").toUpperCase();
  const baseCfg = modeCfg.base || {};
  const semiCfg = modeCfg.semi || {};
  const fullCfg = modeCfg.full || {};
  const downgradeCfg = modeCfg.modeDowngrade || {};
  const regimeText = String(signal.regime || "").toUpperCase();
  const isTrendRegime = regimeText === "TREND_UP" || regimeText === "TREND_DOWN";
  const isRangeRegime = regimeText === "RANGE";
  const modeAccountForTrade = buildModeAccountView(working, executionMode);
  const accountInitial = Math.max(1, Number(modeAccountForTrade.initialBalanceJpy || working.account?.initialBalanceJpy || 1_000_000));
  const accountCurrent = Math.max(0, Number(modeAccountForTrade.currentBalanceJpy || working.account?.currentBalanceJpy || accountInitial));
  const ddPercent = accountCurrent < accountInitial ? ((accountInitial - accountCurrent) / accountInitial) * 100 : 0;
  const trailingLosses = Number(killSwitch?.trailingLosses || 0);
  const rollingBlocked = Boolean(rollingExpectancy?.shouldRescue || rollingExpectancy?.shouldThrottle || rollingExpectancy?.shouldStop);
  const dailyLossWarningLimit = Number(resolveRiskProfile(working.settings.selectedRiskProfile).dailyWarningLossJPY || 1000);
  const capitalScaling = evaluateCapitalScaling({
    state: working,
    currentBalanceJPY: accountCurrent,
    cfg: RUNTIME_CONFIG.capitalScaling || {},
    rolling: {
      sampleSize: Number(rollingExpectancy.sampleSize || 0),
      profitFactor: Number(rollingExpectancy.profitFactor || 1),
      expectancyJpy: Number(rollingExpectancy.expectancyJpy || 0),
      expectancyPositive: Number(rollingExpectancy.expectancyR || 0) > 0
    },
    executionStress: String(executionTailGate?.mode || "NORMAL") !== "NORMAL",
    noDrawdownWarning: ddPercent < 4,
    noConsecutiveLossWarning: trailingLosses < 2,
    dailyLossWarning: Number(modeAccountForTrade.dayPnlJpy || 0) <= -dailyLossWarningLimit
  });
  autoRuntime.lastCapitalScaling = capitalScaling.diagnostics;
  if (capitalScaling.enabled) {
    const scalingRuntime = capitalScaling.runtime;
    const scalingEvents = capitalScaling.events || [];
    withState((s) => {
      let next = { ...s, capitalScalingRuntime: scalingRuntime };
      for (const ev of scalingEvents) {
        next = appendAudit(next, `capitalScaling.${ev.event}`, {
          ...ev,
          activeTierId: scalingRuntime.activeTierId,
          candidateTierId: scalingRuntime.candidateTierId,
          currentBalanceJPY: accountCurrent
        });
      }
      return next;
    });
  }
  const recentAutoTrades = (working.trades || [])
    .filter((t) => String(t?.exitReason || "").startsWith("auto-"))
    .slice(-120);
  const recentExpectancyR = (count) => {
    const list = recentAutoTrades.slice(-Math.max(1, Number(count || 1)));
    if (!list.length) return 0;
    const wins = list.filter((t) => Number(t.netPnlJpy || 0) > 0).map((t) => Number(t.netPnlJpy || 0));
    const losses = list.filter((t) => Number(t.netPnlJpy || 0) < 0).map((t) => Math.abs(Number(t.netPnlJpy || 0)));
    const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 1;
    if (!(avgLoss > 0)) return 0;
    const winR = wins.length ? (wins.reduce((s, v) => s + v, 0) / wins.length) / avgLoss : 0;
    const p = wins.length / list.length;
    return p * winR - (1 - p);
  };
  const recentProfitFactor = (count) => {
    const list = recentAutoTrades.slice(-Math.max(1, Number(count || 1)));
    if (!list.length) return 1;
    const gp = list.filter((t) => Number(t.netPnlJpy || 0) > 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0);
    const gl = Math.abs(list.filter((t) => Number(t.netPnlJpy || 0) < 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0));
    return gl > 0 ? gp / gl : (gp > 0 ? 99 : 1);
  };
  const modeEligibility = {
    base: { eligible: true, reasons: [] },
    semi: { eligible: Boolean(semiCfg.enabled ?? true), reasons: [] },
    full: { eligible: Boolean(fullCfg.enabled ?? true), reasons: [] }
  };
  const scalingAllowedModes = capitalScaling?.settingsOverride?.allowedModes || null;
  if (Array.isArray(scalingAllowedModes)) {
    if (!scalingAllowedModes.includes(semiMode)) {
      modeEligibility.semi.eligible = false;
      modeEligibility.semi.reasons.push("capital_scaling_semi_disabled");
    }
    if (!scalingAllowedModes.includes(fullMode)) {
      modeEligibility.full.eligible = false;
      modeEligibility.full.reasons.push("capital_scaling_full_disabled");
    }
  }
  const commonBlocked = Boolean(noTradeZone?.blocked);
  if (commonBlocked) {
    modeEligibility.semi.eligible = false;
    modeEligibility.full.eligible = false;
    modeEligibility.semi.reasons.push("no_trade_blocked");
    modeEligibility.full.reasons.push("no_trade_blocked");
  }
  if (rollingBlocked) {
    modeEligibility.semi.eligible = false;
    modeEligibility.full.eligible = false;
    modeEligibility.semi.reasons.push("rolling_guard_active");
    modeEligibility.full.reasons.push("rolling_guard_active");
  }
  if (trailingLosses >= Number(downgradeCfg.maxConsecutiveLosses || 4)) {
    modeEligibility.semi.eligible = false;
    modeEligibility.full.eligible = false;
    modeEligibility.semi.reasons.push("loss_streak_guard");
    modeEligibility.full.reasons.push("loss_streak_guard");
  }
  const rangeHighEdgeAllowed = Boolean(semiCfg.allowHighEdgeRange ?? true) && isRangeRegime
    && edgeScore >= Number(semiCfg.rangeEdgeScoreThreshold || 1.35);
  if (!(isTrendRegime || rangeHighEdgeAllowed)) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_regime_block");
  }
  if (!isTrendRegime) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_regime_not_trend");
  }
  if (!(edgeScore >= Number(semiCfg.minEdgeScore || 1.2))) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_edge_low");
  }
  if (!(edgeScore >= Number(fullCfg.minEdgeScore || 1.35))) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_edge_low");
  }
  if (!(executionQualityScore >= Number(semiCfg.minExecutionQualityScore || 0.82))) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_execution_quality_low");
  }
  if (!(executionQualityScore >= Number(fullCfg.minExecutionQualityScore || 0.9))) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_execution_quality_low");
  }
  if (!(tailPenaltyMultiplier >= Number(semiCfg.minTailPenaltyMultiplier || 0.88))) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_tail_penalty_low");
  }
  if (!(tailPenaltyMultiplier >= Number(fullCfg.minTailPenaltyMultiplier || 0.95))) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_tail_penalty_low");
  }
  if (recentAutoTrades.length >= Number(downgradeCfg.fullDisableExpectancyLookback || 20)
      && recentExpectancyR(Number(downgradeCfg.fullDisableExpectancyLookback || 20)) < Number(downgradeCfg.fullDisableExpectancyR || 0)) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_recent_expectancy_negative");
  }
  if (recentAutoTrades.length >= Number(downgradeCfg.fullDisablePfLookback || 10)
      && recentProfitFactor(Number(downgradeCfg.fullDisablePfLookback || 10)) < Number(downgradeCfg.fullDisablePf || 1)) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_recent_pf_low");
  }
  if (recentAutoTrades.length >= Number(downgradeCfg.fullDisableSemiPfLookback || 30)
      && recentProfitFactor(Number(downgradeCfg.fullDisableSemiPfLookback || 30)) < Number(downgradeCfg.semiDisablePf || 1.05)) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_recent_pf_low");
  }
  let maxAllowedMode = fullMode;
  let ddRiskBrake = 1;
  const ddBrakes = Array.isArray(downgradeCfg.ddBrakes) ? downgradeCfg.ddBrakes : [];
  for (const b of ddBrakes.sort((a, b) => Number(a.ddPercent || 0) - Number(b.ddPercent || 0))) {
    if (ddPercent >= Number(b.ddPercent || 0)) {
      maxAllowedMode = String(b.maxMode || maxAllowedMode).toUpperCase();
      ddRiskBrake = Math.min(ddRiskBrake, Number(b.riskMultiplier || 1));
    }
  }
  if (maxAllowedMode === semiMode || maxAllowedMode === baseMode) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("dd_brake_full_off");
  }
  if (maxAllowedMode === baseMode) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("dd_brake_semi_off");
  }
  const profileForMode = resolveRiskProfile(working.settings.selectedRiskProfile);
  const semiModeMinBalanceJPY = Number(profileForMode.semiModeMinBalanceJPY || 20000);
  const fullModeMinBalanceJPY = Number(profileForMode.fullModeMinBalanceJPY || 50000);
  if (accountCurrent < fullModeMinBalanceJPY) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("small_capital_full_disabled");
  }
  if (accountCurrent < semiModeMinBalanceJPY) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("small_capital_semi_limited");
  }
  let finalTradeMode = baseMode;
  if (modeEligibility.full.eligible) finalTradeMode = fullMode;
  else if (modeEligibility.semi.eligible) finalTradeMode = semiMode;

  const preTradeMinEdge = Number(RUNTIME_CONFIG.preTradeGuard?.minNetEdgePips || 0.08);
  if (finalTradeMode === fullMode && Number(preTradeGuard.edgeAfterBuffer || 0) < (preTradeMinEdge + Number(fullCfg.preTrade?.extraMinNetEdgePips || 0.03))) {
    modeEligibility.full.eligible = false;
    modeEligibility.full.reasons.push("full_pretrade_ev_low");
    finalTradeMode = modeEligibility.semi.eligible ? semiMode : baseMode;
  }
  if (finalTradeMode === semiMode && Number(preTradeGuard.edgeAfterBuffer || 0) < (preTradeMinEdge + Number(semiCfg.preTrade?.extraMinNetEdgePips || 0.01))) {
    modeEligibility.semi.eligible = false;
    modeEligibility.semi.reasons.push("semi_pretrade_ev_low");
    finalTradeMode = baseMode;
  }
  if (probeLowRateApplied) {
    finalTradeMode = baseMode;
    modeEligibility.semi.eligible = false;
    modeEligibility.full.eligible = false;
    modeEligibility.semi.reasons.push("probe_low_rate");
    modeEligibility.full.reasons.push("probe_low_rate");
  }

  const baseClamp = baseCfg.edgeClamp || {};
  const semiClamp = semiCfg.edgeClamp || {};
  const fullClamp = fullCfg.edgeClamp || {};
  let edgeSizeMultiplier = Number(edgeResult.sizingMultiplier || 1);
  if (finalTradeMode === fullMode) {
    edgeSizeMultiplier = clamp(edgeSizeMultiplier, Number(fullClamp.min || 0.9), Number(fullClamp.max || 2));
  } else if (finalTradeMode === semiMode) {
    edgeSizeMultiplier = clamp(edgeSizeMultiplier, Number(semiClamp.min || 0.8), Number(semiClamp.max || 1.6));
  } else {
    edgeSizeMultiplier = clamp(edgeSizeMultiplier, Number(baseClamp.min || 0.5), Number(baseClamp.max || 1.4));
  }
  if (finalTradeMode === fullMode && capitalScaling?.diagnostics?.fullUnlockStatus === "TRIAL") {
    edgeSizeMultiplier = Math.min(edgeSizeMultiplier, Number(capitalScaling.settingsOverride?.fullTrialRiskMultiplier || 0.5));
  }
  if (Boolean(downgradeCfg.tailMaxScaleEnabled ?? true) && finalTradeMode !== baseMode && tailPenaltyMultiplier < 1) {
    const modeMax = finalTradeMode === fullMode ? Number(fullClamp.max || 2) : Number(semiClamp.max || 1.6);
    edgeSizeMultiplier = Math.min(edgeSizeMultiplier, modeMax * Number(tailPenaltyMultiplier || 1));
  }
  edgeSizeMultiplier = Number(edgeSizeMultiplier.toFixed(4));
  const modeEligibilitySummary = {
    base: { eligible: true, reason: "default", reasons: [] },
    semi: {
      eligible: Boolean(modeEligibility.semi.eligible),
      reason: modeEligibility.semi.reasons.length ? modeEligibility.semi.reasons.join(",") : "eligible",
      reasons: modeEligibility.semi.reasons
    },
    full: {
      eligible: Boolean(modeEligibility.full.eligible),
      reason: modeEligibility.full.reasons.length ? modeEligibility.full.reasons.join(",") : "eligible",
      reasons: modeEligibility.full.reasons
    }
  };
  const aggressiveEligibility = modeEligibilitySummary.full;
  const modeRiskBrakeMultiplier = Number(clamp(ddRiskBrake, 0.3, 1).toFixed(4));
  const selectedRiskPercentBraked = clamp(selectedRiskPercent * modeRiskBrakeMultiplier, 0.1, 100);
  selectedRiskPercent = selectedRiskPercentBraked;
  const slippageRisk = Math.max(0.35, p95Slip / targetSlip);
  autoRuntime.lastTradeMode = finalTradeMode;
  autoRuntime.lastAggressiveEligibility = aggressiveEligibility;
  autoRuntime.lastTradeModeEligibility = modeEligibilitySummary;
  autoRuntime.lastEdgeSizing = {
    edgeScore,
    tradeMode: finalTradeMode,
    aggressiveEligibility,
    eligibility: modeEligibilitySummary,
    sizingMultiplier: Number(edgeSizeMultiplier.toFixed(4)),
    executionQualityScore,
    latencySizingMultiplier: Number(latencySizingMultiplier.toFixed(4)),
    latencyRefMs: dynamicLatencyRefMs,
    latencySoftCapMs: dynamicLatencySoftCapMs,
    microEdge: Number(microEdge.toFixed(4)),
    nearTailThreshold,
    modeRiskBrakeMultiplier,
    tailPenaltyMultiplier: Number(tailPenaltyMultiplier.toFixed(4)),
    tailAwareSizeMultiplier: Number(tailPenaltyMultiplier.toFixed(4))
  };
  const reentryProbeMultiplier = probeLowRateApplied ? 0.35 : 1;
  const entryEvidenceSizeMultiplier = entryEvidenceScore >= 0.75 ? 1 : (entryEvidenceScore >= 0.60 ? 0.55 : 0.35);
  const entryLocationSizeMultiplier = entryLocationDiagnostics.lateEntryDetected || entryLocationDiagnostics.overextendedEntry
    ? Math.min(0.55, Math.max(0.3, entryLocationScore))
    : 1;
  const multiplierBreakdown = [
    { name: "bandit", value: banditSizeMultiplier },
    { name: "anomaly", value: anomalySizeMultiplier },
    { name: "sizing", value: sizingMultiplier },
    { name: "contextValidation", value: validationSizeMultiplier },
    { name: "ensemble", value: ensembleSizeMultiplier },
    { name: "pattern", value: patternSizeMultiplier },
    { name: "preTrade", value: preTradeSizeMultiplier },
    { name: "noTradeZone", value: noTradeZoneSizeMultiplier },
    { name: "edge", value: edgeSizeMultiplier },
    { name: "latency", value: latencySizingMultiplier },
    { name: "tailPenalty", value: tailPenaltyMultiplier },
    { name: "entryEvidence", value: entryEvidenceSizeMultiplier },
    { name: "entryLocation", value: entryLocationSizeMultiplier },
    { name: "reentryProbe", value: reentryProbeMultiplier }
  ];
  const totalSizingMultiplier = multiplierBreakdown.reduce((acc, cur) => acc * Number(cur.value || 1), 1);
  const topMultiplierContributors = multiplierBreakdown
    .slice()
    .sort((a, b) => Number(a.value || 1) - Number(b.value || 1))
    .slice(0, 3)
    .map((x) => ({ name: x.name, value: Number(Number(x.value || 1).toFixed(4)) }));
  const positionSizingDiagnostics = buildPositionSizingDiagnostics({
    state: working,
    signal,
    price: entryRefPrice,
    sizeMultiplier: totalSizingMultiplier,
    maxUnitsOverride: maxQty,
    executionMode,
    capitalScaling
  });
  autoRuntime.lastPositionSizingDiagnostics = positionSizingDiagnostics;
  if (positionSizingDiagnostics.blockedReason) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = `position sizing: ${positionSizingDiagnostics.blockedReason}`;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "position sizing",
      detail: positionSizingDiagnostics.blockedReason,
      positionSizingDiagnostics
    }));
    return;
  }
  const qty = Number(positionSizingDiagnostics.calculatedUnits || 0);
  const finalSizingGuard = evaluateFinalSizingGuard({
    qty,
    diagnostics: positionSizingDiagnostics,
    executionMode,
    availableCapitalJPY: accountCurrent,
    requireStopLoss: executionMode === "LIVE"
  });
  autoRuntime.lastFinalSizingGuard = finalSizingGuard;
  if (!finalSizingGuard.allowed) {
    autoRuntime.lastAction = "HOLD";
    autoRuntime.lastSkipReason = `final sizing guard: ${finalSizingGuard.reason}`;
    withState((s) => appendAudit(s, "auto.skip", {
      reason: "final sizing guard",
      detail: finalSizingGuard.reason,
      finalSizingGuard,
      positionSizingDiagnostics
    }));
    return;
  }
  const sizingTrace = {
    baseMultiplier: 1,
    regimeSizeMultiplier: 1,
    edgeSizeMultiplier,
    noTradeZoneMultiplier: noTradeZoneSizeMultiplier,
    tailPenaltyMultiplier,
    reentryProbeMultiplier,
    multiTimeframeMultiplier: multiTimeframeDiagnostics.multiTimeframeScore,
    trendUpEntryQualityMultiplier: entryLocationSizeMultiplier,
    overextendedMultiplier: entryLocationDiagnostics.overextendedEntry ? entryLocationSizeMultiplier : 1,
    highImpactMultiplier: String(executionProfile.eventTag || "").includes("HIGH") ? 0.7 : 1,
    finalSizeMultiplier: Number(totalSizingMultiplier.toFixed(4)),
    contributors: multiplierBreakdown.map((x) => ({
      name: x.name,
      value: Number(Number(x.value || 1).toFixed(4)),
      reason: x.name
    }))
  };
  const decisionTrace = buildDecisionTrace({
    signal,
    finalAction: probeLowRateApplied ? "PROBE" : "OPEN",
    finalReason: probeLowRateApplied ? "PROBE_LOW_RATE" : "entry allowed",
    mtf: multiTimeframeDiagnostics,
    evidence: entryEvidenceDiagnostics,
    entryLocation: entryLocationDiagnostics,
    preTradeGuard,
    reentryGuard,
    positionSizingDiagnostics,
    executionTailGate
  });
  autoRuntime.lastSizingTrace = sizingTrace;
  autoRuntime.lastDecisionTrace = decisionTrace;
  markAutoProcessTiming(processTiming, "entryReadyNs");
  const lifecycle = simulateOrderLifecycle({
    side: signal.action,
    qty,
    requestedPrice: Number(signal.entryPrice || 0),
    market: ticker,
    config: executionProfile.config
  });
  markAutoProcessTiming(processTiming, "executionDoneNs");
  const processLatency = finalizeAutoProcessTiming(processTiming);
  appendExecutionTelemetry({
    source: "auto",
    session: executionProfile.session,
    eventTag: executionProfile.eventTag,
    spreadPips: Number(ticker.spreadPips || 0),
    slippagePips: Number(lifecycle.slippagePips || 0),
    latencyMs: Number(lifecycle.latencyMs || 0),
    decisionLatencyMs: Math.max(0, Number(processLatency?.totalMs || 0) - Number(processLatency?.executionSimMs || 0)),
    totalPipelineLatencyMs: Number(processLatency?.totalMs || Number(lifecycle.latencyMs || 0)),
    rejected: Boolean(lifecycle.rejected || lifecycle.executedQty <= 0),
    executedQty: Number(lifecycle.executedQty || 0),
    requestedPrice: Number(signal.entryPrice || 0),
    avgFillPrice: Number(lifecycle.avgFillPrice || 0),
    rejectProbability: Number(executionProfile.config?.execution?.rejectProbability || 0),
    executionStress: Number(executionProfile.stress || 0),
    profile: String(signal.signalProfile || "BASELINE"),
    tradeMode: finalTradeMode,
    edgeScore: Number(edgeScore.toFixed(4)),
    sizingMultiplier: Number(totalSizingMultiplier.toFixed(4)),
    positionSizingDiagnostics,
    processLatency
  });
  flushExecutionTelemetry();

  if (lifecycle.rejected || lifecycle.executedQty <= 0) {
    autoRuntime.lastAction = "REJECTED";
    autoRuntime.lastSkipReason = "order rejected or zero fill";
    withState((s) => appendAudit({
      ...s,
      orders: [...s.orders, lifecycle.order],
      fills: [...s.fills, ...lifecycle.fills]
    }, "auto.order.rejected", { orderId: lifecycle.order.id }));
    return;
  }

  const maxHoldSec = computeSystemMaxHoldSec(signal);
  const exitLearning = buildExitLearningAdjustment({
    signal,
    trades: working.trades || [],
    now: new Date(),
    cfg: RUNTIME_CONFIG.exit?.learning || {}
  });
  autoRuntime.lastExitLearning = exitLearning;
  const adjustedSignal = applyExitAdjustmentsToSignal(signal, exitLearning);
  const holdPlan = planAutoHold({
    baseSec: 120 * Number(exitLearning.holdMultiplier || 1),
    maxHoldSec,
    signal: adjustedSignal,
    ticker,
    pipSize: RUNTIME_CONFIG.pipSize
  });
  const openedAt = new Date().toISOString();
  const position = {
    id: randomUUID(),
    source: "auto",
    side: signal.action === "BUY" ? "LONG" : "SHORT",
    qty: lifecycle.executedQty,
    entryPrice: lifecycle.avgFillPrice,
    stopLossPrice: adjustedSignal.stopLossPrice,
    takeProfitPrice: adjustedSignal.takeProfitPrice,
    openedAt,
    closeDueAt: new Date(Date.now() + holdPlan.holdSec * 1000).toISOString(),
    maxHoldSec,
    plannedHoldSec: holdPlan.holdSec,
    holdMultiplier: holdPlan.holdMultiplier,
    qualityScore: holdPlan.qualityScore,
    riskScore: holdPlan.riskScore,
    riskCutPips: holdPlan.riskCutPips,
    status: "OPEN",
    orderId: lifecycle.order.id,
    signalId: signal.id,
    signalRationale: signal.rationale || null,
    signalConfidence: Number(signal.confidence || 0),
    signalConfidenceRaw: Number(signal.confidenceRaw || signal.confidence || 0),
    signalConfidenceCalibrated: Number(signal.confidenceCalibrated || signal.confidence || 0),
    signalMetrics: signal.metrics || null,
    entryEvidenceScore,
    entryEvidenceBreakdown: entryEvidenceDiagnostics.entryEvidenceBreakdown,
    decisionCategory: entryEvidenceDiagnostics.finalCategory,
    entryLocationScore,
    entryLocationDiagnostics,
    multiTimeframeScore: multiTimeframeDiagnostics.multiTimeframeScore,
    shortTermAlignmentScore: multiTimeframeDiagnostics.shortTermAlignmentScore,
    shortTermExhaustionScore: multiTimeframeDiagnostics.shortTermExhaustionScore,
    momentum5mPips: multiTimeframeDiagnostics.momentum5mPips,
    momentum10mPips: multiTimeframeDiagnostics.momentum10mPips,
    rsi5m: multiTimeframeDiagnostics.rsi5m,
    rsi10m: multiTimeframeDiagnostics.rsi10m,
    bbZ5m: multiTimeframeDiagnostics.bbZ5m,
    bbZ10m: multiTimeframeDiagnostics.bbZ10m,
    trendUpEntryQuality,
    lateEntryDiagnostics,
    probeLowRateApplied,
    decisionTrace,
    sizingTrace,
    signalAdaptive: signal.adaptive || null,
    signalNews: signal.news || null,
    linkedEventIds: Array.isArray(signal?.news?.linkedEventIds) ? signal.news.linkedEventIds : [],
    eventFeatureSnapshot: signal?.news?.eventFeatureVector || null,
    eventDominantTag: signal?.news?.dominantTag || null,
    decisionInputHash: signal.decisionInputHash || null,
    parameterSnapshot: signal.parameterSnapshot || null,
    signalProfile: signal.signalProfile || "BASELINE",
    selectedRiskPercent,
    riskCapitalJpy: Number(riskCapitalJpy.toFixed(2)),
    positionSizingDiagnostics,
    capitalScalingDiagnostics: capitalScaling.diagnostics,
    executionMode,
    banditContextKey: banditDecision.contextKey,
    banditHoldScore: Number(banditDecision.holdScore || 0),
    banditActionScore: Number(banditDecision.actionScore || 0),
    banditAdvantage: Number(banditDecision.advantage || 0),
    banditGuardBypassed,
    banditSizeMultiplier,
    sizingMultiplier,
    noTradeZoneSizeMultiplier,
    edgeSizeMultiplier: Number(edgeSizeMultiplier.toFixed(4)),
    edgeScore: Number(edgeScore.toFixed(4)),
    tradeMode: finalTradeMode,
    aggressiveEligibility: aggressiveEligibility,
    modeEligibility: modeEligibilitySummary,
    modeRiskBrakeMultiplier,
    microEdge: Number(microEdge.toFixed(4)),
    executionQualityScore: Number(executionQualityScore.toFixed(4)),
    tailAwareSizeMultiplier: Number(tailPenaltyMultiplier.toFixed(4)),
    tailPenaltyMultiplier: Number(tailPenaltyMultiplier.toFixed(4)),
    finalSizeMultiplier: Number(totalSizingMultiplier.toFixed(4)),
    multiplierContributors: topMultiplierContributors,
    slippageRisk: Number(slippageRisk.toFixed(4)),
    validationMode: contextValidation.mode,
    validationSizeMultiplier,
    ensembleScore: Number(ensembleGate.score || 0),
    ensembleSizeMultiplier,
    patternQualityScore: Number(patternQuality.score || 0),
    patternQualitySizeMultiplier: patternSizeMultiplier,
    preTradeScore: Number(preTradeGuard.score || 0),
    preTradeSizeMultiplier,
    degradationMode: degradationGuard.mode || "NORMAL",
    degradationRiskMultiplier: Number(degradationGuard.riskMultiplier || 1),
    executionSession: executionProfile.session,
    executionStress: executionProfile.stress,
    executionEventStress: executionProfile.eventStress,
    executionEventTag: executionProfile.eventTag,
    objectiveScore: Number(objective.score || 0),
    objectiveNormalized: Number(objective.normalized || 0.5),
    capitalHeatPenalty: Number(capitalAllocation.heatPenalty || 0),
    confidenceCalibrationReady: Boolean(confidenceCalibration.ready),
    exitLearning,
    entryFeeJpy: lifecycle.feeJpy,
    entryFeeRemainingJpy: lifecycle.feeJpy,
    initialRiskPips: Number(holdPlan.riskPips || 0),
    partialExitDone: false,
    partialExitQty: 0,
    partialExitFirstTakePortion: Number(RUNTIME_CONFIG.auto?.partialExit?.firstTakePortion || 0.5),
    partialExitFirstTakeR: Number(RUNTIME_CONFIG.auto?.partialExit?.firstTakeR || 1),
    worstPnlPips: 0,
    worstAt: openedAt,
    slippagePips: lifecycle.slippagePips,
    latencyMs: lifecycle.latencyMs,
    regime: signal.regime || null
  };

  withState((s) => appendAudit({
    ...s,
    orders: [...s.orders, lifecycle.order],
    fills: [...s.fills, ...lifecycle.fills],
    positions: [...s.positions, position]
  }, "auto.position.opened", {
    positionId: position.id,
    qty: position.qty,
    closeDueAt: position.closeDueAt,
    side: position.side,
    plannedHoldSec: holdPlan.holdSec,
    qualityScore: holdPlan.qualityScore,
    riskScore: holdPlan.riskScore,
    selectedRiskPercent,
    positionSizingDiagnostics,
    capitalScalingDiagnostics: capitalScaling.diagnostics,
    signalId: signal.id,
    rationale: signal.rationale,
    confidence: signal.confidence,
    entryEvidenceScore,
    entryEvidenceBreakdown: entryEvidenceDiagnostics.entryEvidenceBreakdown,
    entryLocationDiagnostics,
    multiTimeframeDiagnostics,
    trendUpEntryQuality,
    lateEntryDiagnostics,
    probeLowRateApplied,
    decisionTrace,
    sizingTrace,
    confidenceRaw: Number(signal.confidenceRaw || signal.confidence || 0),
    confidenceCalibrated: Number(signal.confidenceCalibrated || signal.confidence || 0),
    signalProfile: signal.signalProfile || "BASELINE",
    linkedEventIds: Array.isArray(signal?.news?.linkedEventIds) ? signal.news.linkedEventIds : [],
    eventDominantTag: signal?.news?.dominantTag || null,
    banditContextKey: banditDecision.contextKey,
    banditHoldScore: banditDecision.holdScore,
    banditActionScore: banditDecision.actionScore,
    banditAdvantage: banditDecision.advantage,
    banditGuardBypassed,
    banditSizeMultiplier,
    sizingMultiplier,
    noTradeZoneSizeMultiplier,
    edgeSizeMultiplier: Number(edgeSizeMultiplier.toFixed(4)),
    edgeScore: Number(edgeScore.toFixed(4)),
    tradeMode: finalTradeMode,
    aggressiveEligibility,
    modeEligibility: modeEligibilitySummary,
    modeRiskBrakeMultiplier,
    microEdge: Number(microEdge.toFixed(4)),
    executionQualityScore: Number(executionQualityScore.toFixed(4)),
    tailAwareSizeMultiplier: Number(tailPenaltyMultiplier.toFixed(4)),
    tailPenaltyMultiplier: Number(tailPenaltyMultiplier.toFixed(4)),
    finalSizeMultiplier: Number(totalSizingMultiplier.toFixed(4)),
    multiplierContributors: topMultiplierContributors,
    slippageRisk: Number(slippageRisk.toFixed(4)),
    validationMode: contextValidation.mode,
    validationSizeMultiplier,
    ensembleScore: Number(ensembleGate.score || 0),
    ensembleSizeMultiplier,
    patternQualityScore: Number(patternQuality.score || 0),
    patternQualitySizeMultiplier: patternSizeMultiplier,
    preTradeScore: Number(preTradeGuard.score || 0),
    preTradeSizeMultiplier,
    degradationMode: degradationGuard.mode || "NORMAL",
    degradationRiskMultiplier: Number(degradationGuard.riskMultiplier || 1),
    executionSession: executionProfile.session,
    executionStress: executionProfile.stress,
    executionEventStress: executionProfile.eventStress,
    executionEventTag: executionProfile.eventTag,
    objectiveScore: Number(objective.score || 0),
    objectiveNormalized: Number(objective.normalized || 0.5),
    capitalHeatPenalty: Number(capitalAllocation.heatPenalty || 0),
    confidenceCalibrationReady: Boolean(confidenceCalibration.ready),
    exitLearning
  }));

  autoRuntime.lastAction = `OPEN:${position.side}:${position.qty}`;
  autoRuntime.lastSkipReason = null;
  } finally {
    if (!processTiming.marks.executionDoneNs) {
      finalizeAutoProcessTiming(processTiming);
    }
  }
}

function runAutoTraderTickSafe() {
  if (autoRuntime.active) return;
  autoRuntime.active = true;
  try {
    runAutoTraderTick();
    autoRuntime.consecutiveErrors = 0;
    autoRuntime.lastError = null;
  } catch (error) {
    autoRuntime.consecutiveErrors += 1;
    autoRuntime.lastError = String(error?.message || error);
    autoRuntime.lastAction = "ERROR";
    withState((s) => appendAudit(s, "auto.runtime.error", {
      message: autoRuntime.lastError,
      consecutiveErrors: autoRuntime.consecutiveErrors
    }));
  } finally {
    autoRuntime.active = false;
  }
}

async function runNewsCollectorTick() {
  const feeds = parseFeedList(process.env.NEWS_FEED_URLS || "");
  const result = await collectNewsOnce({ feeds });
  const dedupe = new Set(loadState().newsEvents.map((n) => `${String(n.headline || "").toLowerCase()}|${n.eventTime || n.ts}`));
  let inserted = 0;
  let matched = 0;
  withState((s) => {
    const nextItems = [...s.newsEvents];
    for (const item of result.items) {
      const key = `${String(item.headline || "").toLowerCase()}|${item.eventTime || item.ts}`;
      if (dedupe.has(key)) {
        matched += 1;
        continue;
      }
      dedupe.add(key);
      nextItems.push(item);
      inserted += 1;
    }
    return appendAudit({
      ...s,
      newsEvents: nextItems.slice(-2000)
    }, "news.auto.ingested", {
      fetched: result.items.length,
      inserted
    });
  });
  newsRuntime.lastRunAt = new Date().toISOString();
  newsRuntime.lastSuccessAt = newsRuntime.lastRunAt;
  newsRuntime.lastFetchedCount = result.items.length;
  newsRuntime.lastInsertedCount = inserted;
  newsRuntime.lastMatchedCount = matched;
}

async function runNewsCollectorTickSafe() {
  if (newsRuntime.active) return;
  newsRuntime.active = true;
  try {
    await runNewsCollectorTick();
    newsRuntime.consecutiveErrors = 0;
    newsRuntime.lastError = null;
  } catch (error) {
    newsRuntime.consecutiveErrors += 1;
    newsRuntime.lastError = String(error?.message || error);
    withState((s) => appendAudit(s, "news.auto.error", {
      message: newsRuntime.lastError,
      consecutiveErrors: newsRuntime.consecutiveErrors
    }));
  } finally {
    newsRuntime.active = false;
  }
}

function jstDateKey(date = new Date()) {
  const t = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function jstWeekKey(date = new Date()) {
  const t = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const dayMs = 24 * 60 * 60 * 1000;
  const dayOfYear = Math.floor((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - jan1.getTime()) / dayMs) + 1;
  const week = Math.floor((dayOfYear - 1) / 7) + 1;
  return `${y}-W${String(week).padStart(2, "0")}`;
}

function jstMonthKey(date = new Date()) {
  const t = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function maybeGenerateOperationalReports() {
  const now = new Date();
  const state = loadState();
  // P0-3: weekly frequency audit for stop-too-often diagnostics.
  const wk = jstWeekKey(now);
  if (reportRuntime.lastWeeklyKey !== wk) {
    try {
      const weekly = buildWeeklyFrequencyReport(state, now);
      reportRuntime.lastWeeklyKey = wk;
      withState((s) => appendAudit(s, "reports.weekly.generated", {
        key: wk,
        file: weekly.file,
        hardBlockCount: Number(weekly.hardBlockCount || 0),
        rescueCount: Number(weekly.rescueCount || 0)
      }));
    } catch {}
  }
  // P1-2: fixed monthly OOS/stress report generation.
  const mk = jstMonthKey(now);
  if (reportRuntime.lastMonthlyKey !== mk) {
    try {
      const monthly = buildMonthlyPerformanceReport(state, now);
      reportRuntime.lastMonthlyKey = mk;
      withState((s) => appendAudit(s, "reports.monthly.generated", {
        key: mk,
        file: monthly.file,
        trades: Number(monthly.summary?.totalTrades || 0),
        oosTrades: Number(monthly.oos?.totalTrades || 0)
      }));
    } catch {}
  }
}

function buildDailyLearningReport(state) {
  const trades = state.trades || [];
  const report200 = analyticsValidationReport200(trades, RUNTIME_CONFIG.benchmark);
  const summaryAll = analyticsSummary(trades);
  const eventImpact = analyticsEventImpact(trades, { minTrades: 3 });
  const walkForward = computeWalkForwardTuning(trades, { lookback: 300, minSample: 80 });
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    dateJst: jstDateKey(new Date()),
    tradesTotal: trades.length,
    summaryAll,
    report200,
    walkForward,
    topTags: (eventImpact.tagItems || []).slice(0, 8),
    topEvents: (eventImpact.eventItems || []).slice(0, 12)
  };
}

function runDailyLearningBatch() {
  const state = loadState();
  const tradeCount = Array.isArray(state.trades) ? state.trades.length : 0;
  if (tradeCount === 0) {
    dailyLearningRuntime.lastRunAt = new Date().toISOString();
    dailyLearningRuntime.lastDateJst = jstDateKey(new Date());
    return;
  }
  const dateKey = jstDateKey(new Date());
  const snapshot = createPolicySnapshot(`daily-${dateKey}`);
  const retrain = retrainBanditFromTrades({
    trades: state.trades || [],
    config: getRuntimeLearningConfig(),
    halfLife: 120
  });
  const report = buildDailyLearningReport(state);
  const executionCalibration = computeExecutionCalibration(state, RUNTIME_CONFIG.executionCalibration || {});
  autoRuntime.executionCalibration = executionCalibration;
  appendLearningReport({
    ...report,
    snapshotId: snapshot.id,
    retrain,
    executionCalibration
  });

  withState((s) => appendAudit(s, "learning.daily.batch", {
    dateJst: dateKey,
    snapshotId: snapshot.id,
    retrained: retrain.trained,
    skipped: retrain.skipped,
    report200Pass: report.report200.ok ? report.report200.pass : null,
    executionCalibrationReady: executionCalibration.ready
  }));

  dailyLearningRuntime.lastRunAt = new Date().toISOString();
  dailyLearningRuntime.lastDateJst = dateKey;
}

function runDailyLearningBatchSafe() {
  if (dailyLearningRuntime.active) return;
  maybeGenerateOperationalReports();
  const dateKey = jstDateKey(new Date());
  if (dailyLearningRuntime.lastDateJst === dateKey) return;
  dailyLearningRuntime.active = true;
  try {
    runDailyLearningBatch();
    dailyLearningRuntime.lastError = null;
    dailyLearningRuntime.consecutiveErrors = 0;
  } catch (error) {
    dailyLearningRuntime.lastError = String(error?.message || error);
    dailyLearningRuntime.consecutiveErrors += 1;
    withState((s) => appendAudit(s, "learning.daily.error", {
      dateJst: dateKey,
      message: dailyLearningRuntime.lastError,
      consecutiveErrors: dailyLearningRuntime.consecutiveErrors
    }));
  } finally {
    dailyLearningRuntime.active = false;
  }
}

function runShadowLearningTick() {
  if (!Boolean(RUNTIME_CONFIG.shadowAB?.enabled)) {
    shadowLearningRuntime.lastRunAt = new Date().toISOString();
    return;
  }
  initializeShadowRuntime();
  const state = loadState();
  const marketStatus = market.getMarketStatus();
  if (!marketStatus.fxOpen || !marketStatus.realtime) {
    shadowLearningRuntime.lastRunAt = new Date().toISOString();
    return;
  }

  const nowMs = Date.now();
  const sharedTicker = market.step();
  const sharedSets = market.getDecisionCandles();
  const profiles = listShadowProfiles(RUNTIME_CONFIG.shadowAB || {});
  const decisions = profiles.map((profile) => ({
    profile,
    decision: generateSignalFromState(state, null, {
      signalProfile: profile,
      ticker: sharedTicker,
      sets: sharedSets
    })
  }));
  const ticker = sharedTicker;
  for (const row of decisions) {
    processShadowProfile(state, nowMs, ticker, row.profile, row.decision.signal);
  }

  const promotion = evaluateShadowPromotion({
    tradesByProfile: shadowLearningRuntime.tradesByProfile
  }, RUNTIME_CONFIG.shadowAB || {}, new Date(nowMs).toISOString());
  shadowLearningRuntime.lastPromotion = promotion;
  const thompson = selectProfileByThompson({
    tradesByProfile: shadowLearningRuntime.tradesByProfile
  }, RUNTIME_CONFIG.shadowAB || {}, new Date(nowMs));
  shadowLearningRuntime.thompsonDraws = thompson.draws;
  shadowLearningRuntime.exploreProfile = thompson.profile || "BASELINE";
  const nextApproved = promotion.approved ? promotion.bestProfile : "BASELINE";
  if (shadowLearningRuntime.approvedProfile !== nextApproved && !promotion.pending) {
    shadowLearningRuntime.approvedProfile = nextApproved;
    withState((s) => appendAudit(s, "learning.shadow.promoted", {
      approvedProfile: nextApproved,
      reason: promotion.reason,
      thompsonDraws: thompson.draws
    }));
  }

  shadowLearningRuntime.lastRunAt = new Date().toISOString();
}

function processShadowProfile(state, nowMs, ticker, profile, signal) {
  const p = String(profile || "BASELINE").toUpperCase();
  const current = shadowLearningRuntime.positionsByProfile[p] || null;
  if (current) {
    const side = current.side;
    const exitPrice = Number((side === "BUY" ? ticker.bid : ticker.ask).toFixed(3));
    const hitTp = side === "BUY" ? exitPrice >= current.takeProfitPrice : exitPrice <= current.takeProfitPrice;
    const hitSl = side === "BUY" ? exitPrice <= current.stopLossPrice : exitPrice >= current.stopLossPrice;
    const timeout = nowMs >= current.closeDueAtMs;
    if (hitTp || hitSl || timeout) {
      const exitFee = Number((((exitPrice * current.qty) * RUNTIME_CONFIG.execution.feeBps) / 10000).toFixed(2));
      const feeJpy = Number((current.entryFeeJpy + exitFee).toFixed(2));
      const netPnlJpy = calculateNetPnlJpy(side, current.entryPrice, exitPrice, current.qty, feeJpy);
      const pnlPips = Number((((side === "BUY" ? exitPrice - current.entryPrice : current.entryPrice - exitPrice) / RUNTIME_CONFIG.pipSize)).toFixed(3));
      const peak = Math.max(Number(current.peakPnlPips || pnlPips), pnlPips);
      const retracePips = Number(Math.max(0, peak - pnlPips).toFixed(3));
      const trade = {
        signalProfile: p,
        side,
        qty: current.qty,
        entryPrice: current.entryPrice,
        exitPrice,
        entryTime: current.openedAt,
        exitTime: new Date(nowMs).toISOString(),
        holdingSeconds: Math.max(0.1, Number(((nowMs - new Date(current.openedAt).getTime()) / 1000).toFixed(3))),
        netPnlJpy,
        signalConfidence: Number(current.signalConfidence || 0),
        eventDominantTag: current.eventDominantTag || null,
        eventFeatureSnapshot: current.eventFeatureSnapshot || null,
        banditContextKey: current.banditContextKey || null,
        feeJpy,
        peakPnlPips: peak,
        exitPnlPips: pnlPips,
        retracePips,
        exitReason: hitTp ? "shadow-tp" : (hitSl ? "shadow-sl" : "shadow-ttl")
      };
      shadowLearningRuntime.positionsByProfile[p] = null;
      const prevTrades = Array.isArray(shadowLearningRuntime.tradesByProfile[p]) ? shadowLearningRuntime.tradesByProfile[p] : [];
      shadowLearningRuntime.tradesByProfile[p] = [...prevTrades.slice(-199), trade];
      shadowLearningRuntime.updates += 1;
      withState((s) => appendAudit(s, "learning.shadow.updated", {
        profile: p,
        exitReason: trade.exitReason,
        netPnlJpy: trade.netPnlJpy,
        side: trade.side
      }));
    } else {
      const livePnlPips = Number((((side === "BUY" ? exitPrice - current.entryPrice : current.entryPrice - exitPrice) / RUNTIME_CONFIG.pipSize)).toFixed(3));
      shadowLearningRuntime.positionsByProfile[p] = {
        ...current,
        peakPnlPips: Math.max(Number(current.peakPnlPips || livePnlPips), livePnlPips)
      };
    }
  }

  if (shadowLearningRuntime.positionsByProfile[p] || !(signal.action === "BUY" || signal.action === "SELL")) return;
  const action = signal.action;
  const entryPrice = Number((action === "BUY" ? ticker.ask : ticker.bid).toFixed(3));
  if (!(entryPrice > 0) || Number(signal.confidence || 0) < 0.35) return;
  const selectedRiskPercent = clamp(Number(state.settings.autoRiskPercentPerTrade || 1), 1, 100);
  const executionMode = normalizeExecutionModeInput(state.settings.autoExecutionMode, "PAPER_LIVE");
  const riskCapitalJpy = getRiskCapitalJpy(state, executionMode);
  const maxNotionalJpy = Number(riskCapitalJpy || 0) * (selectedRiskPercent / 100);
  const qtyRaw = entryPrice > 0 ? Math.floor(maxNotionalJpy / entryPrice) : 0;
  const qty = Math.max(1000, Math.min(10000, qtyRaw));
  const maxHoldSec = computeSystemMaxHoldSec(signal);
  const holdPlan = planAutoHold({
    baseSec: 90,
    maxHoldSec,
    signal,
    ticker,
    pipSize: RUNTIME_CONFIG.pipSize
  });
  const bandit = decideBanditGuard({ signal, ticker, config: getRuntimeLearningConfig() });
  const entryFeeJpy = Number((((entryPrice * qty) * RUNTIME_CONFIG.execution.feeBps) / 10000).toFixed(2));
  shadowLearningRuntime.positionsByProfile[p] = {
    profile: p,
    side: action,
    qty,
    entryPrice,
    stopLossPrice: Number(signal.stopLossPrice || entryPrice),
    takeProfitPrice: Number(signal.takeProfitPrice || entryPrice),
    openedAt: new Date(nowMs).toISOString(),
    closeDueAtMs: nowMs + holdPlan.holdSec * 1000,
    signalConfidence: Number(signal.confidence || 0),
    eventDominantTag: signal?.news?.dominantTag || null,
    eventFeatureSnapshot: signal?.news?.eventFeatureVector || null,
    banditContextKey: bandit.contextKey || null,
    executionMode,
    riskCapitalJpy: Number(riskCapitalJpy.toFixed(2)),
    peakPnlPips: 0,
    entryFeeJpy
  };
}

function runShadowLearningTickSafe() {
  if (shadowLearningRuntime.active) return;
  shadowLearningRuntime.active = true;
  try {
    runShadowLearningTick();
    shadowLearningRuntime.lastError = null;
    shadowLearningRuntime.consecutiveErrors = 0;
  } catch (error) {
    shadowLearningRuntime.lastError = String(error?.message || error);
    shadowLearningRuntime.consecutiveErrors += 1;
  } finally {
    shadowLearningRuntime.active = false;
  }
}

function hasOpenAutoPosition(positions) {
  return positions.some((p) => p.status === "OPEN" && p.source === "auto");
}

function closeAutoPositions(state, marketTick, { forceCloseAll, stopRequested = false }) {
  const nowMs = Date.now();
  const closedTrades = [];
  let account = { ...state.account };
  let positionUpdated = false;
  let invalidQuoteSkips = 0;
  const partialCfg = RUNTIME_CONFIG.auto?.partialExit || {};
  const partialEnabled = Boolean(partialCfg.enabled);
  const atr1m = atr(market.getCandles("1m", 120), 14);
  const baseTrailAtrMultiplier = clamp(Number(partialCfg.trailAtrMultiplier || 2.4), 1.2, 5);
  const feeBps = Number(RUNTIME_CONFIG.execution.feeBps || 0);

  const nextPositions = state.positions.map((position) => {
    if (!(position.status === "OPEN" && position.source === "auto")) return position;
    const side = position.side === "LONG" ? "BUY" : "SELL";
    const exitPrice = safeExitPriceForSide(side, marketTick);
    if (!(exitPrice > 0)) {
      invalidQuoteSkips += 1;
      return position;
    }
    const dueMsRaw = new Date(position.closeDueAt || position.openedAt).getTime();
    const dueMs = Number.isFinite(dueMsRaw) ? dueMsRaw : (new Date(position.openedAt).getTime() + 1000);
    const maxHoldSec = normalizeAutoSec(position.maxHoldSec || 300, 30, 3600);
    const plannedHoldSec = normalizeAutoSec(position.plannedHoldSec || maxHoldSec, 5, maxHoldSec);
    const hardTtlMs = new Date(position.openedAt).getTime() + maxHoldSec * 1000;
    const hitTp = isTpHit(position, exitPrice);
    const hitSl = isSlHit(position, exitPrice);
    const riskCut = shouldRiskCutPosition(position, exitPrice, nowMs, RUNTIME_CONFIG.pipSize);
    const stopExit = evaluateStopRequestExit(
      position,
      exitPrice,
      nowMs,
      RUNTIME_CONFIG.pipSize,
      {
        stopRequested,
        spreadPips: Number(marketTick?.spreadPips || 0),
        eventRiskLevel: Number(position?.signalNews?.shortTermRiskLevel || 0)
      }
    );
    const ttl = nowMs >= dueMs || nowMs >= hardTtlMs;
    const pnlPipsNow = Number(stopExit.pnlPips || 0);
    const qtyNow = Number(position.qty || 0);
    const minOrderQty = Math.max(1, Number(RUNTIME_CONFIG.execution.minOrderQty || 1));
    const minRemainingQty = Math.max(minOrderQty, Number(partialCfg.minRemainingQty || 1));
    const baseRiskPips = Math.max(0.5, Number(position.initialRiskPips || position.riskCutPips || 1));
    const mfeR = Number((Math.max(0, Number(stopExit.peakPnlPips || 0)) / baseRiskPips).toFixed(4));
    const maeR = Number((Math.abs(Math.min(0, Number(position.worstPnlPips ?? pnlPipsNow))) / baseRiskPips).toFixed(4));

    if (!forceCloseAll && !stopRequested && partialEnabled && !hitTp && !hitSl && !position.partialExitDone) {
      const tailStats = autoRuntime.lastExecutionTailGate?.stats || {};
      const targetSlip = Math.max(0.05, Number(RUNTIME_CONFIG.executionCalibration?.targetSlippagePips || 0.28));
      const tailHigh = Number(tailStats.p95PipelineLatencyMs || 0) >= 800
        || Number(tailStats.p95SlippagePips || 0) >= targetSlip * 1.8
        || Number(tailStats.rejectRate || 0) >= 0.06;
      let degraded = Number(position.degradationRiskMultiplier || 1) < 0.5
        || Number(position.executionStress || 0) >= 1.2
        || tailHigh;
      const adaptiveExit = resolveAdaptivePartialExit({
        partialCfg,
        regime: String(position.regime || ""),
        edgeScore: Number(position.edgeScore || 1),
        tradeMode: String(position.tradeMode || "BASE"),
        degraded
      });
      degraded = adaptiveExit.degraded;
      const partialPlan = computePartialExitPlan({
        pnlPips: pnlPipsNow,
        riskPips: baseRiskPips,
        qty: qtyNow,
        cfg: adaptiveExit.cfg,
        degraded,
        minOrderQty,
        minRemainingQty
      });
      if (partialPlan.shouldPartial) {
        const closeQty = partialPlan.closeQty;
        const remainingQty = partialPlan.remainingQty;
          const entryFeeRemain = Number(position.entryFeeRemainingJpy ?? position.entryFeeJpy ?? 0);
          const entryFeePart = Number((entryFeeRemain * (closeQty / Math.max(1e-9, qtyNow))).toFixed(2));
          const exitFeePart = Number((((exitPrice * closeQty) * feeBps) / 10000).toFixed(2));
          const partFee = Number((entryFeePart + exitFeePart).toFixed(2));
          const netPnlPart = calculateNetPnlJpy(side, Number(position.entryPrice), exitPrice, closeQty, partFee);
          const partialTrade = {
            id: randomUUID(),
            positionId: position.id,
            symbol: "USDJPY",
            side,
            entryPrice: Number(position.entryPrice),
            exitPrice,
            qty: closeQty,
            entryTime: position.openedAt,
            exitTime: new Date(nowMs).toISOString(),
            holdingSeconds: Math.max(0.1, Number(((nowMs - new Date(position.openedAt).getTime()) / 1000).toFixed(3))),
            netPnlJpy: netPnlPart,
            assistantAdopted: true,
            slippagePips: Number(position.slippagePips || 0),
            latencyMs: Number(position.latencyMs || 0),
            feeJpy: partFee,
            exitReason: "auto-partial-1r",
            regime: position.regime || null,
            signalId: position.signalId || null,
            signalRationale: position.signalRationale || null,
            signalConfidence: Number(position.signalConfidence || 0),
            signalMetrics: position.signalMetrics || null,
            entryEvidenceScore: Number(position.entryEvidenceScore || 0),
            entryEvidenceBreakdown: position.entryEvidenceBreakdown || null,
            decisionCategory: position.decisionCategory || null,
            entryLocationScore: Number(position.entryLocationScore || 0),
            entryLocationDiagnostics: position.entryLocationDiagnostics || null,
            multiTimeframeScore: Number(position.multiTimeframeScore || 0),
            shortTermAlignmentScore: Number(position.shortTermAlignmentScore || 0),
            shortTermExhaustionScore: Number(position.shortTermExhaustionScore || 0),
            momentum5mPips: Number(position.momentum5mPips || 0),
            momentum10mPips: Number(position.momentum10mPips || 0),
            rsi5m: position.rsi5m ?? null,
            rsi10m: position.rsi10m ?? null,
            bbZ5m: position.bbZ5m ?? null,
            bbZ10m: position.bbZ10m ?? null,
            trendUpEntryQuality: position.trendUpEntryQuality || null,
            lateEntryDiagnostics: position.lateEntryDiagnostics || null,
            probeLowRateApplied: Boolean(position.probeLowRateApplied),
            decisionTrace: position.decisionTrace || null,
            sizingTrace: position.sizingTrace || null,
            signalAdaptive: position.signalAdaptive || null,
            signalNews: position.signalNews || null,
            linkedEventIds: Array.isArray(position.linkedEventIds) ? position.linkedEventIds : [],
            eventFeatureSnapshot: position.eventFeatureSnapshot || null,
            eventDominantTag: position.eventDominantTag || null,
            peakPnlPips: Number(stopExit.peakPnlPips || pnlPipsNow),
            exitPnlPips: pnlPipsNow,
            retracePips: Number(Math.max(0, Number(stopExit.peakPnlPips || pnlPipsNow) - pnlPipsNow).toFixed(3)),
            decisionInputHash: position.decisionInputHash || null,
            parameterSnapshot: position.parameterSnapshot || null,
            signalProfile: position.signalProfile || "BASELINE",
            selectedRiskPercent: Number(position.selectedRiskPercent || 0),
            banditContextKey: position.banditContextKey || null,
            banditHoldScore: Number(position.banditHoldScore || 0),
            banditActionScore: Number(position.banditActionScore || 0),
            banditAdvantage: Number(position.banditAdvantage || 0),
            banditSizeMultiplier: Number(position.banditSizeMultiplier || 1),
            executionSession: position.executionSession || null,
            executionStress: Number(position.executionStress || 0),
            executionEventStress: Number(position.executionEventStress || 0),
            executionEventTag: position.executionEventTag || null,
            tradeMode: position.tradeMode || "BASE",
            executionQualityScore: Number(position.executionQualityScore || 0),
            tailPenaltyMultiplier: Number(position.tailPenaltyMultiplier || position.tailAwareSizeMultiplier || 1),
            finalSizeMultiplier: Number(position.finalSizeMultiplier || position.sizingMultiplier || 1),
            multiplierContributors: Array.isArray(position.multiplierContributors) ? position.multiplierContributors : [],
            partialExitFirstTakePortion: Number((degraded ? adaptiveExit.cfg.degradedFirstTakePortion : adaptiveExit.cfg.firstTakePortion) || 0),
            partialExitFirstTakeR: Number((degraded ? adaptiveExit.cfg.degradedFirstTakeR : adaptiveExit.cfg.firstTakeR) || 0),
            trailAtrMultiplier: Number(adaptiveExit.trailAtrMultiplier || 0),
            mfeR,
            maeR,
            exitTrace: {
              exitReason: "auto-partial-1r",
              holdingSeconds: Math.max(0.1, Number(((nowMs - new Date(position.openedAt).getTime()) / 1000).toFixed(3))),
              peakPnlPips: Number(stopExit.peakPnlPips || pnlPipsNow),
              exitPnlPips: pnlPipsNow,
              mfeR,
              maeR,
              breakEvenArmed: Number(stopExit.peakPnlPips || 0) >= 0.8,
              peakProtectArmed: Number(stopExit.peakPnlPips || 0) >= 0.6,
              autoPeakTakeNegativePrevented: false,
              partialExitApplied: true,
              trailStopApplied: false,
              finalExitRule: "partial",
              exitRuleReason: "first_take"
            },
            createdAt: new Date().toISOString(),
            partialExit: true
          };
          account = applyTradeToAccount(account, partialTrade.netPnlJpy);
          closedTrades.push(partialTrade);
          appendExecutionTelemetry({
            source: "auto-exit-partial",
            session: String(position.executionSession || "UNKNOWN"),
            eventTag: String(position.executionEventTag || "GENERAL"),
            spreadPips: Number(marketTick.spreadPips || 0),
            slippagePips: Number(position.slippagePips || 0),
            latencyMs: Number(position.latencyMs || 0),
            decisionLatencyMs: 0,
            totalPipelineLatencyMs: Number(position.latencyMs || 0),
            rejected: false,
            executedQty: Number(closeQty || 0),
            requestedPrice: Number(position.entryPrice || 0),
            avgFillPrice: Number(exitPrice || 0),
            rejectProbability: 0,
            executionStress: Number(position.executionStress || 0),
            profile: String(position.signalProfile || "BASELINE"),
            edgeScore: Number(position.edgeScore || 1),
            sizingMultiplier: Number(position.tailPenaltyMultiplier || position.tailAwareSizeMultiplier || 1)
          });
          flushExecutionTelemetry();
          const nextStopLoss = computeAtrTrailingStop({
            side,
            exitPrice,
            currentStopLoss: Number(position.stopLossPrice || 0),
            atrValue: Number(atr1m || 0),
            atrMultiplier: adaptiveExit.trailAtrMultiplier,
            pipSize: RUNTIME_CONFIG.pipSize
          });
          positionUpdated = true;
          return {
            ...position,
            qty: remainingQty,
            stopLossPrice: Number(nextStopLoss.toFixed(6)),
            entryFeeRemainingJpy: Number((entryFeeRemain - entryFeePart).toFixed(2)),
            partialExitDone: true,
            partialExitQty: Number((Number(position.partialExitQty || 0) + closeQty).toFixed(3)),
            partialExitFirstTakePortion: Number((degraded ? adaptiveExit.cfg.degradedFirstTakePortion : adaptiveExit.cfg.firstTakePortion) || 0),
            partialExitFirstTakeR: Number((degraded ? adaptiveExit.cfg.degradedFirstTakeR : adaptiveExit.cfg.firstTakeR) || 0),
            trailAtrMultiplier: adaptiveExit.trailAtrMultiplier,
            peakPnlPips: Number(stopExit.peakPnlPips || pnlPipsNow),
            peakAt: stopExit.peakAt
          };
        }
      }
    if (!(forceCloseAll || hitTp || hitSl || riskCut || ttl || stopExit.shouldClose)) {
      const nextPeak = Number(stopExit.peakPnlPips);
      const prevPeak = Number(position.peakPnlPips ?? Number.NEGATIVE_INFINITY);
      let trailingUpdate = null;
      if (Boolean(position.partialExitDone) && Number(atr1m || 0) > 0) {
        const currentStop = Number(position.stopLossPrice || 0);
        const nextStop = computeAtrTrailingStop({
          side,
          exitPrice,
          currentStopLoss: currentStop,
          atrValue: Number(atr1m || 0),
          atrMultiplier: clamp(Number(position.trailAtrMultiplier || baseTrailAtrMultiplier), 1.2, 5),
          pipSize: RUNTIME_CONFIG.pipSize
        });
        if (Math.abs(nextStop - currentStop) > 1e-9) {
          trailingUpdate = Number(nextStop.toFixed(6));
        }
      }
      if ((Number.isFinite(nextPeak) && Math.abs(nextPeak - prevPeak) > 1e-9) || trailingUpdate !== null) {
        const prevWorst = Number(position.worstPnlPips ?? pnlPipsNow);
        const nextWorst = Math.min(prevWorst, pnlPipsNow);
        positionUpdated = true;
        return {
          ...position,
          peakPnlPips: stopExit.peakPnlPips,
          peakAt: stopExit.peakAt,
          worstPnlPips: Number(nextWorst.toFixed(3)),
          worstAt: nextWorst < prevWorst ? new Date(nowMs).toISOString() : position.worstAt,
          ...(trailingUpdate !== null ? { stopLossPrice: trailingUpdate } : {})
        };
      }
      return position;
    }

    const exitReason = forceCloseAll
      ? "auto-stop"
      : (hitTp
        ? "auto-tp"
        : (hitSl
          ? "auto-sl"
          : (riskCut
            ? "auto-risk-cut"
            : (stopExit.shouldClose ? stopExit.reason : "auto-ttl"))));
    const holdingSeconds = Math.max(0.1, Number(((nowMs - new Date(position.openedAt).getTime()) / 1000).toFixed(3)));
    const exitFee = Number((((exitPrice * position.qty) * feeBps) / 10000).toFixed(2));
    const remainingEntryFee = Number(position.entryFeeRemainingJpy ?? position.entryFeeJpy ?? 0);
    const totalFee = Number((remainingEntryFee + exitFee).toFixed(2));
    const netPnlJpy = calculateNetPnlJpy(side, Number(position.entryPrice), exitPrice, Number(position.qty), totalFee);
    const exitTrace = {
      exitReason,
      holdingSeconds,
      peakPnlPips: Number(stopExit.peakPnlPips || 0),
      exitPnlPips: Number(stopExit.pnlPips || 0),
      mfeR,
      maeR,
      breakEvenArmed: Number(stopExit.peakPnlPips || 0) >= 0.8,
      peakProtectArmed: Number(stopExit.peakPnlPips || 0) >= 0.6,
      autoPeakTakeNegativePrevented: Boolean(stopExit.autoPeakTakeNegativePrevented),
      earlyFailureExit: String(exitReason).includes("early") || String(exitReason).includes("failure"),
      noMfeTimeoutExit: String(exitReason).includes("no-mfe"),
      maeBeforeMfeExit: String(exitReason).includes("mae-before-mfe"),
      quickAdverseMoveExit: String(exitReason).includes("quick-adverse"),
      failedPullbackExit: String(exitReason).includes("failed-pullback"),
      noFollowThroughExit: String(exitReason).includes("no-follow-through"),
      lossCompressionApplied: String(exitReason).includes("risk") || String(exitReason).includes("failure") || String(exitReason).includes("adverse"),
      trailStopApplied: String(exitReason).includes("trail"),
      partialExitApplied: Boolean(position.partialExitDone),
      finalExitRule: exitReason,
      exitRuleReason: exitReason
    };
    autoRuntime.lastEarlyAdverseExitDiagnostics = {
      enabled: true,
      triggered: exitTrace.quickAdverseMoveExit || exitTrace.earlyFailureExit || exitTrace.noFollowThroughExit,
      secondsSinceEntry: holdingSeconds,
      mfePips: Number(stopExit.peakPnlPips || 0),
      maePips: Math.abs(Number(position.worstPnlPips || 0)),
      mfeR,
      maeR,
      reason: exitReason
    };
    autoRuntime.lastFastPeakProtectDiagnostics = {
      peakPnlPips: Number(stopExit.peakPnlPips || 0),
      currentPnlPips: Number(stopExit.pnlPips || 0),
      givebackPips: Number(Math.max(0, Number(stopExit.peakPnlPips || 0) - Number(stopExit.pnlPips || 0)).toFixed(3)),
      minLockedPips: Number(stopExit.minExitPipsAfterPeak || 0),
      breakEvenArmed: exitTrace.breakEvenArmed,
      fastProtectTriggered: String(exitReason).includes("peak-protect"),
      momentumFadeDetected: String(exitReason).includes("momentum-fade")
    };

    const trade = {
      id: randomUUID(),
      positionId: position.id,
      symbol: "USDJPY",
      side,
      entryPrice: Number(position.entryPrice),
      exitPrice,
      qty: Number(position.qty),
      entryTime: position.openedAt,
      exitTime: new Date(nowMs).toISOString(),
      holdingSeconds,
      netPnlJpy,
      assistantAdopted: true,
      slippagePips: Number(position.slippagePips || 0),
      latencyMs: Number(position.latencyMs || 0),
      feeJpy: totalFee,
      exitReason,
      regime: position.regime || null,
      signalId: position.signalId || null,
      signalRationale: position.signalRationale || null,
      signalConfidence: Number(position.signalConfidence || 0),
      signalMetrics: position.signalMetrics || null,
      entryEvidenceScore: Number(position.entryEvidenceScore || 0),
      entryEvidenceBreakdown: position.entryEvidenceBreakdown || null,
      decisionCategory: position.decisionCategory || null,
      entryLocationScore: Number(position.entryLocationScore || 0),
      entryLocationDiagnostics: position.entryLocationDiagnostics || null,
      multiTimeframeScore: Number(position.multiTimeframeScore || 0),
      shortTermAlignmentScore: Number(position.shortTermAlignmentScore || 0),
      shortTermExhaustionScore: Number(position.shortTermExhaustionScore || 0),
      momentum5mPips: Number(position.momentum5mPips || 0),
      momentum10mPips: Number(position.momentum10mPips || 0),
      rsi5m: position.rsi5m ?? null,
      rsi10m: position.rsi10m ?? null,
      bbZ5m: position.bbZ5m ?? null,
      bbZ10m: position.bbZ10m ?? null,
      trendUpEntryQuality: position.trendUpEntryQuality || null,
      lateEntryDiagnostics: position.lateEntryDiagnostics || null,
      probeLowRateApplied: Boolean(position.probeLowRateApplied),
      decisionTrace: position.decisionTrace || null,
      sizingTrace: position.sizingTrace || null,
      signalAdaptive: position.signalAdaptive || null,
      signalNews: position.signalNews || null,
      linkedEventIds: Array.isArray(position.linkedEventIds) ? position.linkedEventIds : [],
      eventFeatureSnapshot: position.eventFeatureSnapshot || null,
      eventDominantTag: position.eventDominantTag || null,
      peakPnlPips: Number(stopExit.peakPnlPips || 0),
      exitPnlPips: Number(stopExit.pnlPips || 0),
      retracePips: Number(Math.max(0, Number(stopExit.peakPnlPips || 0) - Number(stopExit.pnlPips || 0)).toFixed(3)),
      decisionInputHash: position.decisionInputHash || null,
      parameterSnapshot: position.parameterSnapshot || null,
      signalProfile: position.signalProfile || "BASELINE",
      selectedRiskPercent: Number(position.selectedRiskPercent || 0),
      banditContextKey: position.banditContextKey || null,
      banditHoldScore: Number(position.banditHoldScore || 0),
      banditActionScore: Number(position.banditActionScore || 0),
      banditAdvantage: Number(position.banditAdvantage || 0),
      banditSizeMultiplier: Number(position.banditSizeMultiplier || 1),
      executionSession: position.executionSession || null,
      executionStress: Number(position.executionStress || 0),
      executionEventStress: Number(position.executionEventStress || 0),
      executionEventTag: position.executionEventTag || null,
      tradeMode: position.tradeMode || "BASE",
      executionMode: normalizeExecutionModeInput(position.executionMode, "PAPER_LIVE"),
      executionQualityScore: Number(position.executionQualityScore || 0),
      tailPenaltyMultiplier: Number(position.tailPenaltyMultiplier || position.tailAwareSizeMultiplier || 1),
      finalSizeMultiplier: Number(position.finalSizeMultiplier || position.sizingMultiplier || 1),
      multiplierContributors: Array.isArray(position.multiplierContributors) ? position.multiplierContributors : [],
      partialExitFirstTakePortion: Number(position.partialExitFirstTakePortion || partialCfg.firstTakePortion || 0.5),
      partialExitFirstTakeR: Number(position.partialExitFirstTakeR || partialCfg.firstTakeR || 1),
      trailAtrMultiplier: Number(position.trailAtrMultiplier || baseTrailAtrMultiplier),
      mfeR,
      maeR,
      exitTrace,
      createdAt: new Date().toISOString()
    };

    account = applyTradeToAccount(account, trade.netPnlJpy);
    closedTrades.push(trade);
    appendExecutionTelemetry({
      source: "auto-exit",
      session: String(position.executionSession || "UNKNOWN"),
      eventTag: String(position.executionEventTag || "GENERAL"),
      spreadPips: Number(marketTick.spreadPips || 0),
      slippagePips: Number(position.slippagePips || 0),
      latencyMs: Number(position.latencyMs || 0),
      decisionLatencyMs: 0,
      totalPipelineLatencyMs: Number(position.latencyMs || 0),
      rejected: false,
      executedQty: Number(position.qty || 0),
      requestedPrice: Number(position.entryPrice || 0),
      avgFillPrice: Number(exitPrice || 0),
      rejectProbability: 0,
      executionStress: Number(position.executionStress || 0),
      profile: String(position.signalProfile || "BASELINE"),
      tradeMode: String(position.tradeMode || "BASE"),
      edgeScore: Number(position.edgeScore || 1),
      sizingMultiplier: Number(position.tailPenaltyMultiplier || position.tailAwareSizeMultiplier || 1)
    });
    flushExecutionTelemetry();

    return {
      ...position,
      status: "CLOSED",
      closedAt: trade.exitTime,
      exitReason
    };
  });

  if (!closedTrades.length) {
    if (!positionUpdated) return { changed: false, state, closedCount: 0 };
    const nextState = invalidQuoteSkips > 0
      ? appendAudit({
        ...state,
        positions: nextPositions
      }, "auto.exit.skipped.invalid-quote", { skippedPositions: invalidQuoteSkips })
      : {
        ...state,
        positions: nextPositions
      };
    return {
      changed: true,
      state: nextState,
      closedCount: 0
    };
  }
  for (const trade of closedTrades) {
    try { updateBanditFromTrade({ trade, config: getRuntimeLearningConfig() }); } catch {}
  }

  const nextState = appendAudit({
    ...state,
    account,
    positions: nextPositions,
    trades: [...state.trades, ...closedTrades]
  }, "auto.position.closed", {
    count: closedTrades.length,
    reason: forceCloseAll ? "stop" : (stopRequested ? "stop-request" : "rule")
  });

  return { changed: true, state: nextState, closedCount: closedTrades.length };
}

function applyTradeToAccount(account, netPnlJpy) {
  const currentBalanceJpy = Number((account.currentBalanceJpy + netPnlJpy).toFixed(2));
  const dayPnlJpy = Number((account.dayPnlJpy + netPnlJpy).toFixed(2));
  const weekDrawdownJpy = dayPnlJpy < 0 ? Math.abs(dayPnlJpy) : 0;
  return {
    ...account,
    currentBalanceJpy,
    dayPnlJpy,
    weekDrawdownJpy,
    consecutiveLosses: updateConsecutiveLosses(account.consecutiveLosses, netPnlJpy)
  };
}

function isTpHit(position, exitPrice) {
  if (!position.takeProfitPrice) return false;
  if (position.side === "LONG") return exitPrice >= Number(position.takeProfitPrice);
  return exitPrice <= Number(position.takeProfitPrice);
}

function isSlHit(position, exitPrice) {
  if (!position.stopLossPrice) return false;
  if (position.side === "LONG") return exitPrice <= Number(position.stopLossPrice);
  return exitPrice >= Number(position.stopLossPrice);
}
function handleAccount(res, url) {
  const state = loadState();
  const mode = resolveApiMode(state, url);
  const selected = buildModeAccountView(state, mode);
  send(res, 200, {
    ...selected,
    mode,
    modeAccounts: {
      PAPER_LIVE: buildModeAccountView(state, "PAPER_LIVE"),
      LIVE: buildModeAccountView(state, "LIVE")
    }
  });
}

function handleSettingsGet(res) {
  const state = loadState();
  const s = state.settings;
  const price = Number((market.step()?.bid + market.step()?.ask) / 2 || 0);
  const activeExecutionMode = normalizeExecutionModeInput(s.autoExecutionMode, "PAPER_LIVE");
  const capitalScaling = buildCapitalScalingStatus(state, activeExecutionMode);
  const positionSizing = buildPositionSizingSettings(s, buildModeAccountView(state, activeExecutionMode), { settingsOverride: capitalScaling.diagnostics });
  send(res, 200, {
    brokerProfile: BROKER_PROFILE,
    brokerLabel: RUNTIME_CONFIG.brokerMeta?.label || BROKER_PROFILE,
    baselineSpreadPips: Number(RUNTIME_CONFIG.brokerMeta?.baselineSpreadPips || 0.2),
    brokerAvgLatencyMs: Number(RUNTIME_CONFIG.brokerMeta?.avgLatencyMs || RUNTIME_CONFIG.execution?.baseLatencyMs || 280),
    effectiveFeeBps: Number(RUNTIME_CONFIG.execution.feeBps || 0),
    paperLiveMode: PAPER_LIVE_MODE,
    maxRiskPercentPerTrade: s.autoRiskPercentPerTrade,
    autoRiskPercentPerTrade: s.autoRiskPercentPerTrade,
    autoIntervalSec: s.autoIntervalSec,
    autoExecutionMode: normalizeAutoExecutionMode(s.autoExecutionMode),
    ...positionSizing,
    positionSizing,
    positionSizingPreview: buildPositionSizingDiagnostics({ state, price, executionMode: activeExecutionMode, capitalScaling: { diagnostics: capitalScaling.diagnostics, settingsOverride: capitalScaling.diagnostics } }),
    capitalScaling,
    paperCapitalJpy: Number(s.paperCapitalJpy || 10000),
    liveCapitalJpy: Number(s.liveCapitalJpy || 10000),
    enableSelfLearning: true,
    enableNewsFilter: true,
    blockHighImpactNews: true,
    shadowLearningMode: true,
    preEventBlockMinutes: RUNTIME_CONFIG.news.preEventBlockMinutes,
    postEventBlockMinutes: RUNTIME_CONFIG.news.postEventBlockMinutes,
    autoTradeModeConfig: RUNTIME_CONFIG.auto?.tradeMode || {},
    liveGoNoGoConfig: RUNTIME_CONFIG.auto?.liveGoNoGo || {},
    marketFeed: {
      wsConfigured: Boolean(process.env.MARKET_WS_URL),
      httpBridgeConfigured: Boolean(process.env.MARKET_HTTP_TICKER_URL),
      httpProvider: String(process.env.MARKET_HTTP_PROVIDER || ""),
      httpSymbol: String(process.env.MARKET_HTTP_SYMBOL || "USD_JPY"),
      httpPollMs: Number(process.env.MARKET_HTTP_POLL_MS || 1000),
      httpRefreshSec: Number(process.env.MARKET_HTTP_REFRESH_SEC || 20)
    },
    orderExecution: {
      mode: BROKER_ORDER_MODE,
      provider: BROKER_ORDER_PROVIDER || null,
      manualLiveEnabled: BROKER_ORDER_LIVE_MANUAL,
      httpConfigured: Boolean(BROKER_ORDER_HTTP_URL),
      gmoConfigured: Boolean(GMO_FX_API_KEY && GMO_FX_API_SECRET)
    }
  });
}

async function handleSettingsUpdate(req, res) {
  const body = await readBody(req);
  const next = withState((s) => ({
    ...s,
    settings: {
      ...s.settings,
      ...(typeof body.autoRiskPercentPerTrade === "number"
        ? { autoRiskPercentPerTrade: normalizeRiskPercent(body.autoRiskPercentPerTrade) }
        : {}),
      ...(typeof body.autoIntervalSec === "number"
        ? { autoIntervalSec: normalizeAutoSec(body.autoIntervalSec, 0.1, 3600) }
        : {}),
      ...normalizePositionSizingBody(body),
      ...(body.autoExecutionMode !== undefined
        ? { autoExecutionMode: normalizeAutoExecutionMode(body.autoExecutionMode) }
        : {}),
      ...normalizePositionSizingBody(body),
      ...(typeof body.paperCapitalJpy === "number"
        ? { paperCapitalJpy: Math.round(clamp(Number(body.paperCapitalJpy || 10000), 10000, 1000000000)) }
        : {}),
      ...(typeof body.liveCapitalJpy === "number"
        ? { liveCapitalJpy: Math.round(clamp(Number(body.liveCapitalJpy || 10000), 10000, 1000000000)) }
        : {})
    }
  }));
  const price = Number((market.step()?.bid + market.step()?.ask) / 2 || 0);
  const activeExecutionMode = normalizeExecutionModeInput(next.settings.autoExecutionMode, "PAPER_LIVE");
  const capitalScaling = buildCapitalScalingStatus(next, activeExecutionMode);
  const positionSizing = buildPositionSizingSettings(next.settings, buildModeAccountView(next, activeExecutionMode), { settingsOverride: capitalScaling.diagnostics });
  send(res, 200, {
    brokerProfile: BROKER_PROFILE,
    brokerLabel: RUNTIME_CONFIG.brokerMeta?.label || BROKER_PROFILE,
    baselineSpreadPips: Number(RUNTIME_CONFIG.brokerMeta?.baselineSpreadPips || 0.2),
    brokerAvgLatencyMs: Number(RUNTIME_CONFIG.brokerMeta?.avgLatencyMs || RUNTIME_CONFIG.execution?.baseLatencyMs || 280),
    effectiveFeeBps: Number(RUNTIME_CONFIG.execution.feeBps || 0),
    paperLiveMode: PAPER_LIVE_MODE,
    maxRiskPercentPerTrade: next.settings.autoRiskPercentPerTrade,
    autoRiskPercentPerTrade: next.settings.autoRiskPercentPerTrade,
    autoIntervalSec: next.settings.autoIntervalSec,
    autoExecutionMode: normalizeAutoExecutionMode(next.settings.autoExecutionMode),
    ...positionSizing,
    positionSizing,
    positionSizingPreview: buildPositionSizingDiagnostics({ state: next, price, executionMode: activeExecutionMode, capitalScaling: { diagnostics: capitalScaling.diagnostics, settingsOverride: capitalScaling.diagnostics } }),
    capitalScaling,
    paperCapitalJpy: Number(next.settings.paperCapitalJpy || 10000),
    liveCapitalJpy: Number(next.settings.liveCapitalJpy || 10000),
    enableSelfLearning: true,
    enableNewsFilter: true,
    blockHighImpactNews: true,
    shadowLearningMode: true,
    preEventBlockMinutes: RUNTIME_CONFIG.news.preEventBlockMinutes,
    postEventBlockMinutes: RUNTIME_CONFIG.news.postEventBlockMinutes,
    autoTradeModeConfig: RUNTIME_CONFIG.auto?.tradeMode || {},
    liveGoNoGoConfig: RUNTIME_CONFIG.auto?.liveGoNoGo || {},
    marketFeed: {
      wsConfigured: Boolean(process.env.MARKET_WS_URL),
      httpBridgeConfigured: Boolean(process.env.MARKET_HTTP_TICKER_URL),
      httpProvider: String(process.env.MARKET_HTTP_PROVIDER || ""),
      httpSymbol: String(process.env.MARKET_HTTP_SYMBOL || "USD_JPY"),
      httpPollMs: Number(process.env.MARKET_HTTP_POLL_MS || 1000),
      httpRefreshSec: Number(process.env.MARKET_HTTP_REFRESH_SEC || 20)
    },
    orderExecution: {
      mode: BROKER_ORDER_MODE,
      provider: BROKER_ORDER_PROVIDER || null,
      manualLiveEnabled: BROKER_ORDER_LIVE_MANUAL,
      httpConfigured: Boolean(BROKER_ORDER_HTTP_URL),
      gmoConfigured: Boolean(GMO_FX_API_KEY && GMO_FX_API_SECRET)
    }
  });
}

async function handleAutoStatus(res) {
  await refreshMarketTickForStatus();
  const state = loadState();
  const marketStatus = market.getMarketStatus();
  const statusTick = market.step();
  const statusPrice = Number(((Number(statusTick?.bid || 0) + Number(statusTick?.ask || 0)) / 2) || 0);
  const activeExecutionMode = normalizeExecutionModeInput(state.settings.autoExecutionMode, "PAPER_LIVE");
  const activeModeAccount = buildModeAccountView(state, activeExecutionMode);
  const capitalScaling = buildCapitalScalingStatus(state, activeExecutionMode);
  const liveReadiness = evaluateLiveReadiness(state);
  const autoTradesCount = (state.trades || []).filter((t) => String(t?.exitReason || "").startsWith("auto-")).length;
  const tuningGuard = RUNTIME_CONFIG.auto?.tradeMode?.tuningGuard || {};
  const minNoAdjust = Math.max(1, Number(tuningGuard.minTradesNoAdjust || 200));
  const minWeekly = Math.max(minNoAdjust + 1, Number(tuningGuard.minTradesWeeklyAdjust || 500));
  const tuningPhase = autoTradesCount < minNoAdjust
    ? "COLLECT_ONLY"
    : (autoTradesCount < minWeekly ? "WEEKLY_SMALL_ADJUST" : "MONTHLY_STEP_ADJUST");
  const openAutoPositions = state.positions.filter((p) => p.status === "OPEN" && p.source === "auto").length;
  const cooldownRemainingSec = Math.max(0, Math.ceil((Number(autoRuntime.cooldownUntilMs || 0) - Date.now()) / 1000));
  const rollingRescueCooldownRemainingSec = Math.max(0, Math.ceil((Number(autoRuntime.rollingRescueCooldownUntilMs || 0) - Date.now()) / 1000));
  const recentSkipReasons = summarizeRecentAutoSkipReasons(state, 400, 3);

  const currentPositionSizingPreview = buildPositionSizingDiagnostics({
    state,
    price: statusPrice,
    executionMode: activeExecutionMode,
    capitalScaling: {
      diagnostics: capitalScaling.diagnostics,
      settingsOverride: capitalScaling.diagnostics
    }
  });

  const runtimePositionSizingDiagnostics = autoRuntime.lastPositionSizingDiagnostics;

  const positionSizingDiagnostics =
    runtimePositionSizingDiagnostics
    && runtimePositionSizingDiagnostics.capitalScalingDiagnostics
    && Number(runtimePositionSizingDiagnostics.maxEffectiveLeverage || 0) === Number(capitalScaling.diagnostics?.maxEffectiveLeverage || 0)
      ? runtimePositionSizingDiagnostics
      : currentPositionSizingPreview;

  send(res, 200, {
    enabled: Boolean(state.settings.autoModeEnabled),
    stopRequested: Boolean(state.settings.autoStopRequested),
    brokerProfile: BROKER_PROFILE,
    brokerLabel: RUNTIME_CONFIG.brokerMeta?.label || BROKER_PROFILE,
    baselineSpreadPips: Number(RUNTIME_CONFIG.brokerMeta?.baselineSpreadPips || 0.2),
    brokerAvgLatencyMs: Number(RUNTIME_CONFIG.brokerMeta?.avgLatencyMs || RUNTIME_CONFIG.execution?.baseLatencyMs || 280),
    effectiveFeeBps: Number(RUNTIME_CONFIG.execution.feeBps || 0),
    paperLiveMode: PAPER_LIVE_MODE,
    signalProfile: shadowLearningRuntime.approvedProfile || "BASELINE",
    autoRiskPercentPerTrade: state.settings.autoRiskPercentPerTrade,
    autoIntervalSec: state.settings.autoIntervalSec,
    autoExecutionMode: normalizeAutoExecutionMode(state.settings.autoExecutionMode),
    positionSizing: buildPositionSizingSettings(state.settings, activeModeAccount, { settingsOverride: capitalScaling.diagnostics }),
    positionSizingDiagnostics,
    capitalScaling,
    accountRuntime: buildAccountRuntime(state),
    activeModeAccount,
    openAutoPositions,
    enabledSince: autoRuntime.enabledSince,
    consecutiveErrors: autoRuntime.consecutiveErrors,
    lastError: autoRuntime.lastError,
    lastRunAt: autoRuntime.lastRunAt,
    lastAction: autoRuntime.lastAction,
    lastSkipReason: autoRuntime.lastSkipReason,
    lastSignalRationale: autoRuntime.lastSignalRationale,
    anomalyMode: autoRuntime.anomalyMode,
    marketInputMode: String(marketStatus.inputMode || "UNKNOWN"),
    marketRealtimeSource: String(marketStatus.source || "UNKNOWN"),
    marketStatus,
    orderExecution: {
      mode: BROKER_ORDER_MODE,
      provider: BROKER_ORDER_PROVIDER || null,
      manualLiveEnabled: BROKER_ORDER_LIVE_MANUAL,
      httpConfigured: Boolean(BROKER_ORDER_HTTP_URL),
      gmoConfigured: Boolean(GMO_FX_API_KEY && GMO_FX_API_SECRET)
    },
    dataCollection: {
      autoTrades: autoTradesCount,
      tuningPhase,
      minTradesNoAdjust: minNoAdjust,
      minTradesWeeklyAdjust: minWeekly
    },
    shadowAB: {
      approvedProfile: shadowLearningRuntime.approvedProfile,
      profileSamples: Object.fromEntries(
        Object.entries(shadowLearningRuntime.tradesByProfile || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
      ),
      thompsonDraws: shadowLearningRuntime.thompsonDraws,
      lastPromotion: shadowLearningRuntime.lastPromotion,
      banditObservationMode: Boolean(RUNTIME_CONFIG.rlBandit?.observationMode)
    },
    walkForwardGate: autoRuntime.lastWalkForwardGate,
    expectancyGate: autoRuntime.lastExpectancyGate,
    metaGate: autoRuntime.lastMetaGate,
    contextValidation: autoRuntime.lastContextValidation,
    contextValidationGate: autoRuntime.lastContextValidation,
    sizing: autoRuntime.lastSizing,
    objective: autoRuntime.lastObjective,
    capitalAllocation: autoRuntime.lastCapitalAllocation,
    exitLearning: autoRuntime.lastExitLearning,
    confidenceCalibration: autoRuntime.lastConfidenceCalibration,
    preTradeGuard: autoRuntime.lastPreTradeGuard,
    reentryDiagnostics: autoRuntime.lastReentryGuard,
    decisionTrace: autoRuntime.lastDecisionTrace,
    entryEvidenceBreakdown: autoRuntime.lastEntryEvidenceBreakdown,
    entryEvidenceScore: Number(autoRuntime.lastEntryEvidenceBreakdown?.totalScore || 0),
    entryLocationDiagnostics: autoRuntime.lastEntryLocationDiagnostics,
    entryLocationScore: Number(autoRuntime.lastEntryLocationDiagnostics?.entryLocationScore || 0),
    multiTimeframeDiagnostics: autoRuntime.lastMultiTimeframeDiagnostics,
    multiTimeframeScore: Number(autoRuntime.lastMultiTimeframeDiagnostics?.multiTimeframeScore || 0),
    shortTermAlignmentScore: Number(autoRuntime.lastMultiTimeframeDiagnostics?.shortTermAlignmentScore || 0),
    shortTermExhaustionScore: Number(autoRuntime.lastMultiTimeframeDiagnostics?.shortTermExhaustionScore || 0),
    trendUpEntryQuality: autoRuntime.lastTrendUpEntryQuality,
    lateEntryDiagnostics: autoRuntime.lastEntryLocationDiagnostics ? {
      lateEntryDetected: Boolean(autoRuntime.lastEntryLocationDiagnostics.lateEntryDetected),
      recentRunupPips: autoRuntime.lastEntryLocationDiagnostics.recentRunupPips,
      recentRunupBars: autoRuntime.lastEntryLocationDiagnostics.recentRunupBars,
      distanceFromRecentHighPips: autoRuntime.lastEntryLocationDiagnostics.distanceFromRecentHighPips,
      rsi1m: autoRuntime.lastEntryLocationDiagnostics.rsi1m,
      bbZ1m: autoRuntime.lastEntryLocationDiagnostics.bbZ1m,
      rsi5m: autoRuntime.lastEntryLocationDiagnostics.rsi5m,
      bbZ5m: autoRuntime.lastEntryLocationDiagnostics.bbZ5m,
      reason: autoRuntime.lastEntryLocationDiagnostics.reason
    } : null,
    noActionableSignalDiagnostics: autoRuntime.lastNoActionableSignalDiagnostics,
    blockingSummary: buildBlockingSummary({
      lastAction: autoRuntime.lastAction,
      lastSkipReason: autoRuntime.lastSkipReason,
      decisionTrace: autoRuntime.lastDecisionTrace,
      noActionableSignalDiagnostics: autoRuntime.lastNoActionableSignalDiagnostics,
      entryEvidenceBreakdown: autoRuntime.lastEntryEvidenceBreakdown,
      entryEvidenceScore: Number(autoRuntime.lastEntryEvidenceBreakdown?.totalScore || 0),
      preTradeGuard: autoRuntime.lastPreTradeGuard,
      contextValidationGate: autoRuntime.lastContextValidation,
      contextValidation: autoRuntime.lastContextValidation,
      positionSizingDiagnostics,
      finalSizingGuard: autoRuntime.lastFinalSizingGuard
    }),
    sizingTrace: autoRuntime.lastSizingTrace,
    earlyAdverseExitDiagnostics: autoRuntime.lastEarlyAdverseExitDiagnostics,
    fastPeakProtectDiagnostics: autoRuntime.lastFastPeakProtectDiagnostics,
    degradationGuard: autoRuntime.lastDegradationGuard,
    ensembleGate: autoRuntime.lastEnsembleGate,
    patternQualityGate: autoRuntime.lastPatternQualityGate,
    killSwitch: autoRuntime.lastKillSwitch,
    rollingExpectancy: autoRuntime.lastRollingExpectancy,
    liveReadiness,
    executionTailGate: autoRuntime.lastExecutionTailGate,
    noTradeZone: autoRuntime.lastNoTradeZone,
    edgeSizing: autoRuntime.lastEdgeSizing,
    finalSizingGuard: autoRuntime.lastFinalSizingGuard,
    tradeMode: autoRuntime.lastTradeMode || "BASE",
    aggressiveEligibility: autoRuntime.lastAggressiveEligibility || { eligible: false, reason: "not-evaluated", reasons: [] },
    eligibility: autoRuntime.lastTradeModeEligibility || {
      base: { eligible: true, reason: "default", reasons: [] },
      semi: { eligible: false, reason: "not-evaluated", reasons: [] },
      full: { eligible: false, reason: "not-evaluated", reasons: [] }
    },
    partialExit: {
      enabled: Boolean(RUNTIME_CONFIG.auto?.partialExit?.enabled),
      firstTakeR: Number(RUNTIME_CONFIG.auto?.partialExit?.firstTakeR || 1),
      firstTakePortion: Number(RUNTIME_CONFIG.auto?.partialExit?.firstTakePortion || 0.5),
      degradedFirstTakeR: Number(RUNTIME_CONFIG.auto?.partialExit?.degradedFirstTakeR || 0.8),
      degradedFirstTakePortion: Number(RUNTIME_CONFIG.auto?.partialExit?.degradedFirstTakePortion || 0.6),
      trailAtrMultiplier: Number(RUNTIME_CONFIG.auto?.partialExit?.trailAtrMultiplier || 2.4),
      trendHighEdgeScore: Number(RUNTIME_CONFIG.auto?.partialExit?.trendHighEdgeScore || 1.2),
      trendFirstTakePortion: Number(RUNTIME_CONFIG.auto?.partialExit?.trendFirstTakePortion || 0.35),
      trendFirstTakeR: Number(RUNTIME_CONFIG.auto?.partialExit?.trendFirstTakeR || 1.2),
      trendTrailAtrMultiplier: Number(RUNTIME_CONFIG.auto?.partialExit?.trendTrailAtrMultiplier || 2.8),
      rangeLowEdgeScore: Number(RUNTIME_CONFIG.auto?.partialExit?.rangeLowEdgeScore || 1.1),
      rangeFirstTakePortion: Number(RUNTIME_CONFIG.auto?.partialExit?.rangeFirstTakePortion || 0.6),
      rangeFirstTakeR: Number(RUNTIME_CONFIG.auto?.partialExit?.rangeFirstTakeR || 0.9),
      rangeTrailAtrMultiplier: Number(RUNTIME_CONFIG.auto?.partialExit?.rangeTrailAtrMultiplier || 2.0),
      aggressive: RUNTIME_CONFIG.auto?.partialExit?.aggressive || {},
      semiAggressive: RUNTIME_CONFIG.auto?.partialExit?.semiAggressive || {},
      fullAggressive: RUNTIME_CONFIG.auto?.partialExit?.fullAggressive || {}
    },
    executionCalibration: autoRuntime.executionCalibration,
    processLatency: autoRuntime.processLatency,
    learningMemory: autoRuntime.learningMemory,
    banditGuardHoldStreak: autoRuntime.banditGuardHoldStreak,
    banditGuardBypassCount: autoRuntime.banditGuardBypassCount,
    rollbackWarmupSec: Math.max(0, Math.ceil((Number(autoRuntime.rollbackWarmupUntilMs || 0) - Date.now()) / 1000)),
    cooldownRemainingSec,
    cooldownReason: autoRuntime.cooldownReason,
    rollingRescueCooldownRemainingSec,
    rollingRescueReason: autoRuntime.rollingRescueReason,
    rollingRescueStage: Number(autoRuntime.rollingRescueStage || 0),
    recentSkipReasons
  });
}

function handleCapitalScalingStatus(res) {
  const state = loadState();
  const executionMode = normalizeExecutionModeInput(state.settings.autoExecutionMode, "PAPER_LIVE");
  send(res, 200, buildCapitalScalingStatus(state, executionMode));
}

function summarizeRecentAutoSkipReasons(state, limitLogs = 400, topN = 3) {
  const logs = Array.isArray(state?.auditLogs) ? state.auditLogs.slice(-Math.max(20, Number(limitLogs) || 400)) : [];
  const reasonCount = new Map();
  const ignoreWalkForward = !Boolean(RUNTIME_CONFIG.walkForwardGate?.enforceForAuto);
  for (const row of logs) {
    if (row?.event !== "auto.skip") continue;
    const reason = String(row?.reason || "unknown").trim() || "unknown";
    if (ignoreWalkForward && reason === "walk-forward gate") continue;
    reasonCount.set(reason, Number(reasonCount.get(reason) || 0) + 1);
  }
  const top = Array.from(reasonCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Number(topN) || 3))
    .map(([reason, count]) => ({ reason, count }));
  return {
    totalSkips: Array.from(reasonCount.values()).reduce((s, n) => s + Number(n || 0), 0),
    uniqueReasons: reasonCount.size,
    top
  };
}

async function handleAutoStart(req, res) {
  const body = await readBody(req);
  const requestedExecutionMode = normalizeAutoExecutionMode(body.autoExecutionMode);
  const state = loadState();
  const liveReadiness = evaluateLiveReadiness(state);
  const allowPaperFallback = Boolean(RUNTIME_CONFIG.auto?.liveGoNoGo?.fallbackToPaperLiveOnFail ?? true);
  const liveBlocked = requestedExecutionMode === "LIVE" && !liveReadiness.ready;
  const effectiveExecutionMode = liveBlocked && allowPaperFallback ? "PAPER_LIVE" : requestedExecutionMode;
  if (liveBlocked && !allowPaperFallback) {
    return send(res, 409, {
      error: "LIVE開始条件を満たしていません",
      liveReadiness
    });
  }
  const next = withState((s) => appendAudit({
    ...s,
    settings: {
      ...s.settings,
      autoModeEnabled: true,
      autoStopRequested: false,
      autoExecutionMode: effectiveExecutionMode,
      ...(typeof body.autoRiskPercentPerTrade === "number"
        ? { autoRiskPercentPerTrade: normalizeRiskPercent(body.autoRiskPercentPerTrade) }
        : {}),
      ...(typeof body.autoIntervalSec === "number"
        ? { autoIntervalSec: normalizeAutoSec(body.autoIntervalSec, 0.1, 3600) }
        : {})
    }
  }, "auto.mode.changed", {
    enabled: true,
    autoExecutionMode: effectiveExecutionMode,
    requestedExecutionMode,
    liveFallbackApplied: liveBlocked && allowPaperFallback,
    liveReadiness
  }));
  autoRuntime.enabledSince = new Date().toISOString();
  autoRuntime.lastAction = "RUNNING";
  autoRuntime.lastError = null;
  autoRuntime.consecutiveErrors = 0;
  autoRuntime.lastWalkForwardGate = null;
  autoRuntime.lastExpectancyGate = null;
  autoRuntime.lastMetaGate = null;
  autoRuntime.lastContextValidation = null;
  autoRuntime.lastSizing = null;
  autoRuntime.lastObjective = null;
  autoRuntime.lastCapitalAllocation = null;
  autoRuntime.lastExitLearning = null;
  autoRuntime.lastConfidenceCalibration = null;
  autoRuntime.lastPreTradeGuard = null;
  autoRuntime.lastDegradationGuard = null;
  autoRuntime.lastEnsembleGate = null;
  autoRuntime.lastPatternQualityGate = null;
  autoRuntime.lastKillSwitch = null;
  autoRuntime.lastRollingExpectancy = null;
  autoRuntime.lastExecutionTailGate = null;
  autoRuntime.lastNoTradeZone = null;
  autoRuntime.lastPositionSizingDiagnostics = null;
  autoRuntime.rollingRescueStage = 0;
  autoRuntime.lastEdgeSizing = null;
  autoRuntime.lastTradeMode = "BASE";
  autoRuntime.lastAggressiveEligibility = { eligible: false, reason: "not-evaluated", reasons: [] };
  autoRuntime.lastTradeModeEligibility = {
    base: { eligible: true, reason: "default", reasons: [] },
    semi: { eligible: false, reason: "not-evaluated", reasons: [] },
    full: { eligible: false, reason: "not-evaluated", reasons: [] }
  };
  autoRuntime.cooldownUntilMs = 0;
  autoRuntime.cooldownReason = null;
  autoRuntime.rollingRescueCooldownUntilMs = 0;
  autoRuntime.rollingRescueReason = null;
  autoRuntime.lastSkipReason = null;
  autoRuntime.lastSignalRationale = null;
  autoRuntime.processLatency = { last: null, ewma: null, samples: 0 };
  autoRuntime.anomalyMode = "NORMAL";
  autoRuntime.anomalyModeUntilMs = 0;
  autoRuntime.banditGuardHoldStreak = 0;
  autoRuntime.banditGuardStreakStartedMs = 0;
  autoRuntime.banditGuardLastContext = null;
  autoRuntime.banditGuardBypassCount = 0;
  autoRuntime.executionTailGuardUntilMs = 0;
  autoRuntime.executionTailGuardReason = null;
  send(res, 200, {
    ...next.settings,
    requestedExecutionMode,
    effectiveExecutionMode,
    liveFallbackApplied: liveBlocked && allowPaperFallback,
    warning: liveBlocked && allowPaperFallback
      ? "LIVE条件未達のためPAPER_LIVEで開始しました"
      : null,
    liveReadiness
  });
}

function handleAutoStop(res) {
  let immediateStopped = false;
  const next = withState((s) => {
    const autoEnabled = Boolean(s.settings.autoModeEnabled);
    const openAutoPositions = (s.positions || []).filter((p) => p.status === "OPEN" && p.source === "auto").length;
    const stopRequested = autoEnabled && openAutoPositions > 0;
    immediateStopped = autoEnabled && openAutoPositions === 0;
    return appendAudit({
      ...s,
      settings: {
        ...s.settings,
        autoModeEnabled: stopRequested ? true : false,
        autoStopRequested: stopRequested
      }
    }, "auto.stop.requested", {
      ts: new Date().toISOString(),
      accepted: autoEnabled,
      immediateStopped,
      openAutoPositions
    });
  });
  if (immediateStopped) {
    autoRuntime.enabledSince = null;
    autoRuntime.lastAction = "STOP:0";
  } else {
    autoRuntime.lastAction = next.settings.autoStopRequested ? "STOP_PENDING" : "IDLE";
  }
  send(res, 200, next.settings);
}

function handleNewsList(res, url) {
  const state = loadState();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 30), 200));
  const items = [...state.newsEvents].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, limit);
  send(res, 200, { items, total: state.newsEvents.length });
}

function handleNewsStatus(res) {
  const state = loadState();
  const nowMs = Date.now();
  const cutoffMs = nowMs - 6 * 60 * 60 * 1000;
  const decisionActiveCount = (state.newsEvents || []).filter((n) => {
    const ts = new Date(n.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoffMs;
  }).length;
  send(res, 200, {
    pollMs: NEWS_LOOP_MS,
    lastRunAt: newsRuntime.lastRunAt,
    lastSuccessAt: newsRuntime.lastSuccessAt,
    lastFetchedCount: newsRuntime.lastFetchedCount,
    lastInsertedCount: newsRuntime.lastInsertedCount,
    lastMatchedCount: newsRuntime.lastMatchedCount,
    decisionActiveCount,
    consecutiveErrors: newsRuntime.consecutiveErrors,
    lastError: newsRuntime.lastError
  });
}

async function handleNewsIngest(req, res) {
  const body = await readBody(req);
  if (!body.headline || !String(body.headline).trim()) {
    return send(res, 400, { error: "headline is required" });
  }
  const item = normalizeNewsItem(body);
  const next = withState((s) => ({
    ...s,
    newsEvents: [...s.newsEvents.slice(-999), item]
  }));
  send(res, 201, { item, total: next.newsEvents.length });
}

function handleAuditList(res, url) {
  const state = loadState();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 1000));
  const items = [...state.auditLogs].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, limit);
  send(res, 200, { items, total: state.auditLogs.length });
}

async function handleAccountReset(req, res) {
  const body = await readBody(req);
  const resetLearning = Boolean(body?.resetLearning);
  const next = withState((s) => ({
    ...s,
    settings: {
      ...s.settings,
      autoModeEnabled: false,
      autoStopRequested: false
    },
    account: {
      initialBalanceJpy: Number(s.settings.balanceJPY || s.settings.paperCapitalJpy || 10000),
      currentBalanceJpy: Number(s.settings.balanceJPY || s.settings.paperCapitalJpy || 10000),
      dayPnlJpy: 0,
      weekDrawdownJpy: 0,
      consecutiveLosses: 0
    },
    trades: [],
    assistantSignals: [],
    orders: [],
    fills: [],
    positions: [],
    auditLogs: []
  }));
  if (resetLearning) {
    // Optional full learning reset (explicit-only).
    shadowLearningRuntime.positionsByProfile = {};
    shadowLearningRuntime.tradesByProfile = {};
    shadowLearningRuntime.lastPromotion = null;
    shadowLearningRuntime.thompsonDraws = {};
    shadowLearningRuntime.exploreProfile = "BASELINE";
    shadowLearningRuntime.approvedProfile = "BASELINE";
    shadowLearningRuntime.updates = 0;
    initializeShadowRuntime();
    autoRuntime.learningMemory = resetLearningMemory();
  }
  autoRuntime.lastObjective = null;
  autoRuntime.lastCapitalAllocation = null;
  autoRuntime.lastExitLearning = null;
  autoRuntime.lastConfidenceCalibration = null;
  autoRuntime.lastPreTradeGuard = null;
  autoRuntime.lastDegradationGuard = null;
  autoRuntime.lastEnsembleGate = null;
  autoRuntime.lastPatternQualityGate = null;
  autoRuntime.lastKillSwitch = null;
  autoRuntime.lastRollingExpectancy = null;
  autoRuntime.lastExecutionTailGate = null;
  autoRuntime.lastNoTradeZone = null;
  autoRuntime.lastEdgeSizing = null;
  autoRuntime.lastSizing = null;
  autoRuntime.lastContextValidation = null;
  autoRuntime.lastMetaGate = null;
  autoRuntime.lastExpectancyGate = null;
  autoRuntime.lastWalkForwardGate = null;
  autoRuntime.executionTailGuardUntilMs = 0;
  autoRuntime.executionTailGuardReason = null;
  autoRuntime.processLatency = { last: null, ewma: null, samples: 0 };
  autoRuntime.rollingRescueCooldownUntilMs = 0;
  autoRuntime.rollingRescueReason = null;
  send(res, 200, {
    resetAt: new Date().toISOString(),
    account: next.account,
    learningReset: resetLearning
  });
}

function handleLearningReset(res) {
  shadowLearningRuntime.positionsByProfile = {};
  shadowLearningRuntime.tradesByProfile = {};
  shadowLearningRuntime.lastPromotion = null;
  shadowLearningRuntime.thompsonDraws = {};
  shadowLearningRuntime.exploreProfile = "BASELINE";
  shadowLearningRuntime.approvedProfile = "BASELINE";
  shadowLearningRuntime.updates = 0;
  initializeShadowRuntime();
  autoRuntime.learningMemory = resetLearningMemory();
  send(res, 200, {
    resetAt: new Date().toISOString(),
    learningReset: true,
    learningMemory: autoRuntime.learningMemory
  });
}

function handleAnalytics(res, url) {
  const state = loadState();
  if (url.pathname === "/api/v1/analytics/summary") {
    return send(res, 200, analyticsSummary(state.trades, url.searchParams.get("from"), url.searchParams.get("to")));
  }
  if (url.pathname === "/api/v1/analytics/by-hour") {
    return send(res, 200, { items: analyticsByHour(state.trades) });
  }
  if (url.pathname === "/api/v1/analytics/by-weekday") {
    return send(res, 200, { items: analyticsByWeekday(state.trades) });
  }
  if (url.pathname === "/api/v1/analytics/assistant-impact") {
    return send(res, 200, analyticsAssistantImpact(state.trades));
  }
  if (url.pathname === "/api/v1/analytics/event-impact") {
    const minTrades = Math.max(1, Math.min(Number(url.searchParams.get("minTrades") || 3), 50));
    return send(res, 200, analyticsEventImpact(state.trades, { minTrades }));
  }
  if (url.pathname === "/api/v1/analytics/gate-performance") {
    const limit = Math.max(100, Math.min(Number(url.searchParams.get("limit") || 3000), 20000));
    return send(res, 200, analyticsGatePerformance(state.trades, state.auditLogs, { limit }));
  }
  if (url.pathname === "/api/v1/analytics/report-200") {
    return send(res, 200, analyticsValidationReport200(state.trades, RUNTIME_CONFIG.benchmark));
  }
  return notFound(res);
}

function handleExecutionStats(res, url) {
  const lookback = Math.max(100, Math.min(Number(url.searchParams.get("lookback") || 5000), 50000));
  const recent = Math.max(1, Math.min(Number(url.searchParams.get("recent") || 50), 5000));
  const stats = getExecutionTelemetryStats({ lookback });
  const items = listExecutionTelemetry(recent);
  send(res, 200, { stats, items });
}

async function handlePolicySnapshotCreate(req, res) {
  const body = await readBody(req);
  const label = String(body.label || "").trim() || `manual-${new Date().toISOString()}`;
  const out = createPolicySnapshot(label);
  send(res, 201, out);
}

function handlePolicySnapshotsList(res) {
  send(res, 200, { items: listPolicySnapshots() });
}

async function handlePolicySnapshotRestore(req, res) {
  const body = await readBody(req);
  const id = String(body.id || "").trim();
  if (!id) return send(res, 400, { error: "id is required" });
  const restored = restorePolicySnapshot(id);
  if (!restored) return send(res, 404, { error: "snapshot not found" });
  send(res, 200, restored);
}

function handleLearningDailyStatus(res) {
  send(res, 200, {
    active: dailyLearningRuntime.active,
    lastRunAt: dailyLearningRuntime.lastRunAt,
    lastDateJst: dailyLearningRuntime.lastDateJst,
    lastError: dailyLearningRuntime.lastError,
    consecutiveErrors: dailyLearningRuntime.consecutiveErrors,
    learningMemory: autoRuntime.learningMemory,
    realtimeShadow: {
      active: shadowLearningRuntime.active,
      updates: shadowLearningRuntime.updates,
      approvedProfile: shadowLearningRuntime.approvedProfile,
      hasOpenPosition: Object.values(shadowLearningRuntime.positionsByProfile || {}).some(Boolean),
      openByProfile: Object.fromEntries(
        Object.entries(shadowLearningRuntime.positionsByProfile || {}).map(([k, v]) => [k, Boolean(v)])
      ),
      samplesByProfile: Object.fromEntries(
        Object.entries(shadowLearningRuntime.tradesByProfile || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
      ),
      lastPromotion: shadowLearningRuntime.lastPromotion,
      thompsonDraws: shadowLearningRuntime.thompsonDraws,
      exploreProfile: shadowLearningRuntime.exploreProfile,
      lastRunAt: shadowLearningRuntime.lastRunAt,
      lastError: shadowLearningRuntime.lastError,
      consecutiveErrors: shadowLearningRuntime.consecutiveErrors
    }
  });
}

function handleLearningReports(res, url) {
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 20), 180));
  send(res, 200, { items: listLearningReports(limit) });
}

function handleWeeklyReport(res) {
  const state = loadState();
  send(res, 200, buildWeeklyFrequencyReport(state, new Date()));
}

function handleMonthlyReport(res) {
  const state = loadState();
  send(res, 200, buildMonthlyPerformanceReport(state, new Date()));
}

function handleAblationReport(res, url) {
  const state = loadState();
  const ablation = String(url.searchParams.get("ablation") || process.env.ABLATION || "");
  send(res, 200, buildAblationReport(state, ablation));
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);

      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (serveStatic(url.pathname, res)) return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/v1/market/ticker") return handleTicker(res);
      if (req.method === "GET" && url.pathname === "/api/v1/market/stream") return handleTickerStream(res);
      if (req.method === "GET" && url.pathname === "/api/v1/market/candles") return handleCandles(res, url);
      if (req.method === "GET" && url.pathname === "/api/v1/market/status") return handleMarketStatus(res);
      if (req.method === "GET" && url.pathname === "/api/v1/assistant/recommendation") return handleRecommendation(res);
      if (req.method === "GET" && url.pathname === "/api/v1/trades") return handleTradesList(res, url);
      if (req.method === "POST" && url.pathname === "/api/v1/trades") return handleCreateTrade(req, res);
      if (req.method === "GET" && url.pathname === "/api/v1/positions") return handlePositionsList(res, url);
      if (req.method === "POST" && /^\/api\/v1\/positions\/[^/]+\/close$/.test(url.pathname)) {
        const id = url.pathname.split("/")[4];
        return handleClosePosition(req, res, id);
      }
      if (req.method === "POST" && url.pathname === "/api/v1/orders/execute") return handleExecuteOrder(req, res);
      if (req.method === "GET" && url.pathname === "/api/v1/account") return handleAccount(res, url);
      if (req.method === "GET" && url.pathname === "/api/v1/execution/stats") return handleExecutionStats(res, url);
      if (req.method === "POST" && url.pathname === "/api/v1/account/reset") return handleAccountReset(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/learning/reset") return handleLearningReset(res);
      if (req.method === "GET" && url.pathname === "/api/v1/settings") return handleSettingsGet(res);
      if (req.method === "POST" && url.pathname === "/api/v1/settings") return handleSettingsUpdate(req, res);
      if (req.method === "GET" && url.pathname === "/api/v1/auto/status") return handleAutoStatus(res);
      if (req.method === "GET" && url.pathname === "/api/v1/capital-scaling/status") return handleCapitalScalingStatus(res);
      if (req.method === "POST" && url.pathname === "/api/v1/auto/start") return handleAutoStart(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/auto/stop") return handleAutoStop(res);
      if (req.method === "GET" && url.pathname === "/api/v1/news") return handleNewsList(res, url);
      if (req.method === "GET" && url.pathname === "/api/v1/news/status") return handleNewsStatus(res);
      if (req.method === "POST" && url.pathname === "/api/v1/news/ingest") return handleNewsIngest(req, res);
      if (req.method === "GET" && url.pathname === "/api/v1/audit") return handleAuditList(res, url);
      if (req.method === "GET" && url.pathname === "/api/v1/learning/policy/snapshots") return handlePolicySnapshotsList(res);
      if (req.method === "POST" && url.pathname === "/api/v1/learning/policy/snapshot") return handlePolicySnapshotCreate(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/learning/policy/restore") return handlePolicySnapshotRestore(req, res);
      if (req.method === "GET" && url.pathname === "/api/v1/learning/daily/status") return handleLearningDailyStatus(res);
      if (req.method === "GET" && url.pathname === "/api/v1/learning/reports") return handleLearningReports(res, url);
      if (req.method === "GET" && url.pathname === "/api/v1/reports/weekly") return handleWeeklyReport(res);
      if (req.method === "GET" && url.pathname === "/api/v1/reports/monthly") return handleMonthlyReport(res);
      if (req.method === "GET" && url.pathname === "/api/v1/reports/ablation") return handleAblationReport(res, url);
      if (req.method === "GET" && url.pathname.startsWith("/api/v1/analytics/")) return handleAnalytics(res, url);

      return notFound(res);
    } catch (error) {
      return send(res, 500, {
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setInterval(runAutoTraderTickSafe, AUTO_LOOP_MS);
  setInterval(runShadowLearningTickSafe, SHADOW_LEARNING_LOOP_MS);
  setInterval(runDailyLearningBatchSafe, 60 * 1000);
  runShadowLearningTickSafe();
  runDailyLearningBatchSafe();
  if (String(process.env.NEWS_AUTO_ENABLED || "true").toLowerCase() !== "false") {
    setInterval(() => {
      runNewsCollectorTickSafe().catch(() => {});
    }, NEWS_LOOP_MS);
    runNewsCollectorTickSafe().catch(() => {});
  }
  const server = createApiServer();
  server.listen(PORT, () => {
    console.log(`FX API server running on http://localhost:${PORT}`);
  });
}

function createAutoProcessTiming() {
  return {
    startedNs: process.hrtime.bigint(),
    marks: {}
  };
}

function markAutoProcessTiming(timing, key) {
  if (!timing || !key) return;
  timing.marks[key] = process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1_000_000;
}

function spanMs(fromNs, toNs) {
  if (!fromNs || !toNs || toNs <= fromNs) return 0;
  return Number(nsToMs(toNs - fromNs).toFixed(3));
}

function finalizeAutoProcessTiming(timing) {
  if (!timing?.startedNs) return null;
  const endNs = process.hrtime.bigint();
  const m = timing.marks || {};
  const baseEnd = m.baseCheckedNs || endNs;
  const decisionEnd = m.decisionReadyNs || endNs;
  const riskEnd = m.entryReadyNs || endNs;
  const executionEnd = m.executionDoneNs || endNs;
  const sample = {
    totalMs: Number(spanMs(timing.startedNs, endNs).toFixed(3)),
    baseChecksMs: Number(spanMs(timing.startedNs, baseEnd).toFixed(3)),
    decisionMs: Number(spanMs(baseEnd, decisionEnd).toFixed(3)),
    riskGateMs: Number(spanMs(decisionEnd, riskEnd).toFixed(3)),
    executionSimMs: Number(spanMs(riskEnd, executionEnd).toFixed(3))
  };
  const prevEwma = autoRuntime.processLatency?.ewma || null;
  const alpha = 0.2;
  const ewma = {
    totalMs: Number((((prevEwma?.totalMs ?? sample.totalMs) * (1 - alpha)) + sample.totalMs * alpha).toFixed(3)),
    baseChecksMs: Number((((prevEwma?.baseChecksMs ?? sample.baseChecksMs) * (1 - alpha)) + sample.baseChecksMs * alpha).toFixed(3)),
    decisionMs: Number((((prevEwma?.decisionMs ?? sample.decisionMs) * (1 - alpha)) + sample.decisionMs * alpha).toFixed(3)),
    riskGateMs: Number((((prevEwma?.riskGateMs ?? sample.riskGateMs) * (1 - alpha)) + sample.riskGateMs * alpha).toFixed(3)),
    executionSimMs: Number((((prevEwma?.executionSimMs ?? sample.executionSimMs) * (1 - alpha)) + sample.executionSimMs * alpha).toFixed(3))
  };
  autoRuntime.processLatency = {
    last: sample,
    ewma,
    samples: Number(autoRuntime.processLatency?.samples || 0) + 1
  };
  return sample;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAutoSec(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Number(clamp(n, min, max).toFixed(3));
}

function normalizeRiskPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(clamp(n, 1, 100));
}

function normalizeAutoExecutionMode(value) {
  const mode = String(value || "PAPER_LIVE").toUpperCase();
  return mode === "LIVE" ? "LIVE" : "PAPER_LIVE";
}

function countTrailingLosses(trades) {
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    if (Number(trades[i].netPnlJpy) < 0) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function evaluateAutoEntryCooldown(state, nowMs) {
  const previousCooldown = Number(autoRuntime.cooldownUntilMs || 0);
  const cfg = RUNTIME_CONFIG.auto?.entryCooldown || {};
  const lookbackTrades = Math.max(3, Number(cfg.lookbackTrades || 8));
  const minSampleTrades = Math.max(3, Number(cfg.minSampleTrades || 5));
  const triggerConsecutiveLosses = Math.max(2, Number(cfg.triggerConsecutiveLosses || 3));
  const triggerLossRate = clamp(Number(cfg.triggerLossRate || 0.7), 0.5, 1);
  const cooldownSec = normalizeAutoSec(Number(cfg.cooldownSec || 90), 10, 1800);
  const recentAutoTrades = state.trades
    .filter((t) => String(t.exitReason || "").startsWith("auto-"))
    .slice(-lookbackTrades);
  const losses = recentAutoTrades.filter((t) => Number(t.netPnlJpy) < 0).length;
  const consecutiveLosses = countTrailingLosses(recentAutoTrades);
  const lossRate = recentAutoTrades.length > 0 ? losses / recentAutoTrades.length : 0;
  const needsCooldown = recentAutoTrades.length >= minSampleTrades
    && (consecutiveLosses >= triggerConsecutiveLosses || lossRate >= triggerLossRate);

  if (needsCooldown && nowMs >= previousCooldown) {
    autoRuntime.cooldownUntilMs = nowMs + cooldownSec * 1000;
    autoRuntime.cooldownReason = consecutiveLosses >= triggerConsecutiveLosses
      ? `連敗保護(${consecutiveLosses}連敗)`
      : `損失率保護(${Math.round(lossRate * 100)}%)`;
    return {
      active: true,
      startedNow: true,
      clearedNow: false,
      reason: autoRuntime.cooldownReason,
      cooldownSec,
      remainingSec: cooldownSec,
      lossesInWindow: losses,
      sampleTrades: recentAutoTrades.length
    };
  }

  if (nowMs < Number(autoRuntime.cooldownUntilMs || 0)) {
    return {
      active: true,
      startedNow: false,
      clearedNow: false,
      reason: autoRuntime.cooldownReason || "cooldown",
      cooldownSec,
      remainingSec: Math.max(1, Math.ceil((autoRuntime.cooldownUntilMs - nowMs) / 1000)),
      lossesInWindow: losses,
      sampleTrades: recentAutoTrades.length
    };
  }

  const clearedNow = previousCooldown > 0 && nowMs >= previousCooldown;
  autoRuntime.cooldownUntilMs = 0;
  return {
    active: false,
    startedNow: false,
    clearedNow,
    reason: null,
    cooldownSec: 0,
    remainingSec: 0,
    lossesInWindow: losses,
    sampleTrades: recentAutoTrades.length
  };
}

function evaluateAutoReentryGuard({ state, signal, ticker, sets, nowMs }) {
  const cfg = RUNTIME_CONFIG.auto?.reentryGuard || {};
  if (!Boolean(cfg.enabled)) return { blocked: false };
  const action = String(signal?.action || "");
  if (!(action === "BUY" || action === "SELL")) return { blocked: false };
  const recent = (Array.isArray(state?.trades) ? state.trades : [])
    .filter((t) => String(t?.source || "").toLowerCase() === "auto" || String(t?.exitReason || "").startsWith("auto-"))
    .filter((t) => t?.side === action)
    .filter((t) => Number(t?.exitPrice || 0) > 0)
    .filter((t) => Number.isFinite(new Date(t?.exitTime || 0).getTime()))
    .sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0));
  const last = recent.at(-1);
  if (!last) return { blocked: false };
  const exitReason = String(last.exitReason || "");
  const lastExitMs = new Date(last.exitTime).getTime();
  const elapsedSec = Number.isFinite(lastExitMs) ? Math.max(0, (nowMs - lastExitMs) / 1000) : Number.POSITIVE_INFINITY;
  const stopLossExit = exitReason.includes("sl") || exitReason.includes("stop") || exitReason.includes("risk-cut");
  const profitTake = exitReason.includes("take") || exitReason.includes("tp");
  const regime = String(signal?.regime || "").toUpperCase();
  const isTrendRegime = regime === "TREND_UP" || regime === "TREND_DOWN";
  const isRangeRegime = regime === "RANGE";
  const isHighVolRegime = regime === "HIGH_VOLATILITY";
  const sameDirectionReentry = true;
  const tpBaseCooldown = Math.max(10, Number(cfg.cooldownSecAfterTakeProfit || 90));
  const tpTrendCooldown = Math.max(10, Number(cfg.cooldownSecAfterTakeProfitTrend || 45));
  const tpRangeCooldown = Math.max(10, Number(cfg.cooldownSecAfterTakeProfitRange || 180));
  const slBaseCooldown = Math.max(10, Number(cfg.cooldownSecAfterStopLoss || 360));
  const hiVolCooldownMin = Math.max(60, Number(cfg.highVolOrSameDirectionCooldownSecMin || 420));
  const hiVolCooldownMax = Math.max(hiVolCooldownMin, Number(cfg.highVolOrSameDirectionCooldownSecMax || 600));
  let minCooldownSec = stopLossExit ? slBaseCooldown : tpBaseCooldown;
  if (profitTake && isTrendRegime) minCooldownSec = tpTrendCooldown;
  if (profitTake && isRangeRegime) minCooldownSec = tpRangeCooldown;
  if (stopLossExit && sameDirectionReentry) {
    minCooldownSec = clamp(slBaseCooldown + 120, hiVolCooldownMin, hiVolCooldownMax);
  }
  if (isHighVolRegime) {
    minCooldownSec = clamp(minCooldownSec + 60, hiVolCooldownMin, hiVolCooldownMax);
  }
  const pipSize = Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01));
  const minPullbackPips = Math.max(0.2, Number(cfg.minPullbackPips || 1.2));
  const minMomentum = Number(cfg.minMomentumForImmediateReentry || 0.08);
  const minSlope = Number(cfg.minTrendSlope15mPipsForImmediateReentry || 0.18);
  const quote = action === "BUY" ? Number(ticker?.ask || 0) : Number(ticker?.bid || 0);
  if (!(quote > 0)) return { blocked: false };
  const lastExit = Number(last.exitPrice || 0);
  const pullbackPips = action === "BUY"
    ? (lastExit - quote) / pipSize
    : (quote - lastExit) / pipSize;
  const momentum = Number(signal?.marketFeatures?.momentumScore || 0);
  const slope15 = Number(signal?.metrics?.trendSlope15mPips ?? signal?.marketFeatures?.trendSlope15mPips ?? 0);
  const rationale = String(signal?.rationale || "").toLowerCase();
  const strongChartRecoveryReasons = [];
  const strongChartRecoveryBlockedReasons = [];
  const signalStrengthForRecovery = Number(signal?.confidence || signal?.confidenceCalibrated || 0);
  const recoveryRationaleOk = rationale.includes("pullback re-acceleration")
    || rationale.includes("trend continuation")
    || rationale.includes("re-acceleration");
  if (signalStrengthForRecovery >= 0.70) strongChartRecoveryReasons.push("signal_strength_ok");
  else strongChartRecoveryBlockedReasons.push("signal_strength_low");
  if (recoveryRationaleOk) strongChartRecoveryReasons.push("rationale_ok");
  else strongChartRecoveryBlockedReasons.push("rationale_not_recovery");
  if (!isHighVolRegime) strongChartRecoveryReasons.push("not_high_volatility");
  else strongChartRecoveryBlockedReasons.push("high_volatility");
  const strongMomentumResume = action === "BUY"
    ? (momentum >= Math.max(0.04, minMomentum * 0.75) && slope15 >= Math.max(0.08, minSlope * 0.5))
    : (momentum <= -Math.max(0.04, minMomentum * 0.75) && slope15 <= -Math.max(0.08, minSlope * 0.5));
  if (strongMomentumResume) strongChartRecoveryReasons.push("momentum_resume");
  else strongChartRecoveryBlockedReasons.push("momentum_not_resumed");
  const strongChartRecoveryEligible = Boolean(stopLossExit
    && elapsedSec < minCooldownSec
    && signalStrengthForRecovery >= 0.70
    && recoveryRationaleOk
    && !isHighVolRegime
    && strongMomentumResume);

  if ((profitTake || stopLossExit) && elapsedSec < minCooldownSec) {
    const hasPricePullback = pullbackPips >= minPullbackPips;
    const hasMomentumResume = action === "BUY"
      ? (momentum >= minMomentum && slope15 >= minSlope)
      : (momentum <= -minMomentum && slope15 <= -minSlope);
    if (strongChartRecoveryEligible) {
      return {
        blocked: false,
        reasonCode: "REENTRY_PROBE_RECOVERY",
        reason: "損切り直後だが強い再加速のため低レート再開",
        lastExitType: stopLossExit ? "SL" : "TP",
        lastExitSide: action,
        lastExitAt: last.exitTime,
        sameSideReentry: true,
        elapsedSec: Number(elapsedSec.toFixed(1)),
        minCooldownSec,
        cooldownRemainingSec: Math.max(0, Math.ceil(minCooldownSec - elapsedSec)),
        pullbackPips: Number(pullbackPips.toFixed(2)),
        minPullbackPips,
        lastExitReason: exitReason,
        strongChartRecoveryEligible: true,
        strongChartRecoveryReasons,
        strongChartRecoveryBlockedReasons,
        downgradedToProbeLowRate: true
      };
    }
    if (!(hasPricePullback && hasMomentumResume)) {
      return {
        blocked: true,
        reasonCode: "REENTRY_COOLDOWN",
        reason: stopLossExit
          ? `${action}損切り直後の再エントリー待機`
          : (isHighVolRegime ? `${action}高ボラ時の再エントリー待機` : `${action}利確直後の再エントリー待機`),
        elapsedSec: Number(elapsedSec.toFixed(1)),
        minCooldownSec,
        cooldownRemainingSec: Math.max(0, Math.ceil(minCooldownSec - elapsedSec)),
        pullbackPips: Number(pullbackPips.toFixed(2)),
        minPullbackPips,
        lastExitReason: exitReason,
        lastExitType: stopLossExit ? "SL" : "TP",
        lastExitSide: action,
        lastExitAt: last.exitTime,
        sameSideReentry: true,
        strongChartRecoveryEligible: false,
        strongChartRecoveryReasons,
        strongChartRecoveryBlockedReasons,
        downgradedToProbeLowRate: false
      };
    }
  }

  const tc = cfg.trendContinuation || {};
  if (Boolean(tc.enabled)) {
    const candles1m = Array.isArray(sets?.candles1m) ? sets.candles1m : [];
    const lookbackBars = Math.max(5, Number(tc.lookbackBars1m || 12));
    const slice = candles1m.slice(-lookbackBars);
    if (slice.length >= 5) {
      const firstClose = Number(slice[0]?.close || 0);
      const lastClose = Number(slice.at(-1)?.close || 0);
      const minLow = Math.min(...slice.map((c) => Number(c?.low ?? c?.close ?? lastClose)));
      const maxHigh = Math.max(...slice.map((c) => Number(c?.high ?? c?.close ?? lastClose)));
      if (firstClose > 0 && lastClose > 0 && Number.isFinite(minLow) && Number.isFinite(maxHigh)) {
        const movePips = (lastClose - firstClose) / pipSize;
        const reboundPips = (lastClose - minLow) / pipSize;
        const pullbackFromHighPips = (maxHigh - lastClose) / pipSize;
        if (action === "BUY"
          && movePips <= -Math.max(0.5, Number(tc.minDownMovePipsForBuyBlock || 1.8))
          && reboundPips < Math.max(0.2, Number(tc.minReboundPipsForBuy || 0.7))) {
          return {
            blocked: true,
            reasonCode: "DOWN_CONTINUATION_BUY_BLOCK",
            reason: "下落継続中のため買い見送り",
            movePips: Number(movePips.toFixed(2)),
            reboundPips: Number(reboundPips.toFixed(2))
          };
        }
        if (action === "SELL"
          && movePips >= Math.max(0.5, Number(tc.minUpMovePipsForSellBlock || 1.8))
          && pullbackFromHighPips < Math.max(0.2, Number(tc.minPullbackPipsForSell || 0.7))) {
          return {
            blocked: true,
            reasonCode: "UP_CONTINUATION_SELL_BLOCK",
            reason: "上昇継続中のため売り見送り",
            movePips: Number(movePips.toFixed(2)),
            pullbackPips: Number(pullbackFromHighPips.toFixed(2))
          };
        }
      }
    }
  }

  return { blocked: false };
}

function computeSystemMaxHoldSec(signal) {
  const metrics = signal?.metrics || {};
  const ev = Number(metrics.expectedValuePips || 0);
  const rr = Number(metrics.rr || 1);
  const spread = Number(metrics.spreadPips || Number(RUNTIME_CONFIG.brokerMeta?.baselineSpreadPips || 0.18));
  const conf = Number(signal?.confidence || 0.3);
  const newsRisk = Number(signal?.news?.shortTermRiskLevel || 0);
  const quality = ev * 90 + (rr - 1) * 70 + conf * 45 - spread * 55 - newsRisk * 120;
  return normalizeAutoSec(clamp(120 + quality, 30, 900), 30, 900);
}

function resolveAdaptivePartialExit({ partialCfg, regime, edgeScore, tradeMode = "BASE", degraded }) {
  const cfg = { ...(partialCfg || {}) };
  const upperRegime = String(regime || "").toUpperCase();
  const isTrend = upperRegime === "TREND_UP" || upperRegime === "TREND_DOWN";
  const isRange = upperRegime === "RANGE";
  const modeText = String(tradeMode || "BASE").toUpperCase();
  const isSemi = modeText === "SEMI";
  const isFull = modeText === "FULL" || modeText === "AGGRESSIVE";
  const t = clamp((Number(edgeScore || 1) - 0.9) / 0.6, 0, 1);
  const lerp = (a, b, x) => a + (b - a) * x;

  // P1: uptime-first continuous exit map to avoid regime mis-switch discontinuities.
  cfg.firstTakePortion = clamp(lerp(0.65, 0.35, t), 0.1, 0.9);
  cfg.firstTakeR = Math.max(0.5, lerp(0.85, 1.2, t));
  let trailAtrMultiplier = clamp(lerp(2.0, 2.8, t), 1.2, 5);
  if (isTrend) {
    trailAtrMultiplier = clamp(trailAtrMultiplier + 0.1, 1.2, 5);
  } else if (isRange) {
    trailAtrMultiplier = clamp(trailAtrMultiplier - 0.1, 1.2, 5);
  }
  if ((isSemi || isFull) && isTrend) {
    // P0: mode-aware trend exits for BASE/SEMI/FULL.
    const ag = isFull ? (cfg.fullAggressive || cfg.aggressive || {}) : (cfg.semiAggressive || {});
    cfg.firstTakePortion = clamp(
      lerp(
        Number(ag.maxFirstTakePortion || (isFull ? 0.3 : 0.45)),
        Number(ag.minFirstTakePortion || (isFull ? 0.2 : 0.35)),
        t
      ),
      0.1,
      0.9
    );
    cfg.firstTakeR = Math.max(0.5, lerp(
      Number(ag.minFirstTakeR || (isFull ? 1.35 : 1.15)),
      Number(ag.maxFirstTakeR || (isFull ? 1.6 : 1.3)),
      t
    ));
    trailAtrMultiplier = clamp(
      lerp(
        Number(ag.minTrailAtrMultiplier || (isFull ? 3.0 : 2.6)),
        Number(ag.maxTrailAtrMultiplier || (isFull ? 3.5 : 2.9)),
        t
      ),
      1.2,
      5
    );
  }

  let adjustedDegraded = Boolean(degraded);
  if (adjustedDegraded) {
    cfg.degradedFirstTakePortion = clamp(Number(cfg.firstTakePortion || 0.5) + 0.06, 0.1, 0.9);
    cfg.degradedFirstTakeR = Math.max(0.5, Number(cfg.firstTakeR || 1) - 0.08);
    trailAtrMultiplier = clamp(trailAtrMultiplier - 0.12, 1.2, 5);
    if (isTrend) {
      cfg.degradedFirstTakePortion = clamp(cfg.degradedFirstTakePortion - 0.04, 0.1, 0.9);
      cfg.degradedFirstTakeR = Math.max(0.5, cfg.degradedFirstTakeR + 0.04);
      trailAtrMultiplier = clamp(trailAtrMultiplier + 0.08, 1.2, 5);
    }
    if (isSemi || isFull) {
      const ag = isFull ? (cfg.fullAggressive || cfg.aggressive || {}) : (cfg.semiAggressive || {});
      cfg.degradedFirstTakePortion = Math.min(
        clamp(Number(cfg.degradedFirstTakePortion || cfg.firstTakePortion || 0.5), 0.1, 0.9),
        Number(ag.degradedPortionCap || (isFull ? 0.45 : 0.5))
      );
      cfg.degradedFirstTakeR = Math.max(Number(cfg.degradedFirstTakeR || cfg.firstTakeR || 1), Number(cfg.firstTakeR || 1));
    }
  }
  return { cfg, trailAtrMultiplier, degraded: adjustedDegraded };
}

function computeMicroEdgeScore({ candles1m, action, lookbackBars = 18 }) {
  const list = Array.isArray(candles1m) ? candles1m : [];
  const n = Math.max(6, Number(lookbackBars || 18));
  const recent = list.slice(-(n + 1));
  if (recent.length < 8) return 0;
  const returns = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = Number(recent[i - 1]?.close || 0);
    const cur = Number(recent[i]?.close || 0);
    if (prev > 0 && cur > 0) returns.push((cur - prev) / prev);
  }
  if (returns.length < 6) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const std = Math.sqrt(Math.max(variance, 1e-12));
  const latest = returns[returns.length - 1];
  const z = (latest - mean) / std;
  const dir = action === "BUY" ? 1 : (action === "SELL" ? -1 : 0);
  return Number(clamp(z * dir, -1, 1).toFixed(4));
}

function buildPreTradeSpreadStats(tailStats = null) {
  const stats = tailStats || {};
  const alpha = clamp(Number(RUNTIME_CONFIG.preTradeGuard?.dynamicSpreadGate?.ewmaAlpha || 0.08), 0.01, 0.5);
  const prevEwma = Number(autoRuntime.lastPreTradeGuard?.spreadReferencePips || stats.avgSpreadPips || RUNTIME_CONFIG.brokerMeta?.baselineSpreadPips || 0.18);
  const avg = Number(stats.avgSpreadPips || prevEwma);
  const ewmaSpreadPips = Number(((1 - alpha) * prevEwma + alpha * avg).toFixed(4));
  return {
    avgSpreadPips: Number(avg.toFixed(4)),
    spreadStdPips: Number(stats.spreadStdPips || 0),
    ewmaSpreadPips
  };
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function meanNum(values) {
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!list.length) return 0;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

function stdNum(values) {
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (list.length < 2) return 0;
  const avg = meanNum(list);
  return Math.sqrt(list.reduce((s, v) => s + (v - avg) ** 2, 0) / (list.length - 1));
}

function computeSimpleRsiFromCloses(closes, period = 14) {
  const list = (Array.isArray(closes) ? closes : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (list.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const slice = list.slice(-(period + 1));
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return Number((100 - (100 / (1 + rs))).toFixed(2));
}

function computeBbZFromCloses(closes, period = 20) {
  const list = (Array.isArray(closes) ? closes : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const slice = list.slice(-Math.max(5, period));
  if (slice.length < 5) return 0;
  const avg = meanNum(slice);
  const sd = stdNum(slice) || 0.0001;
  return Number(((slice.at(-1) - avg) / sd).toFixed(4));
}

function slopePips(candles, lookback = 5) {
  const list = Array.isArray(candles) ? candles : [];
  const slice = list.slice(-Math.max(2, lookback));
  if (slice.length < 2) return 0;
  const first = safeNum(slice[0]?.close, 0);
  const last = safeNum(slice.at(-1)?.close, 0);
  if (!(first > 0 && last > 0)) return 0;
  return Number(((last - first) / Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01))).toFixed(3));
}

function buildSynthetic10mCandles(candles1m = []) {
  const list = Array.isArray(candles1m) ? candles1m : [];
  const out = [];
  for (let i = Math.max(0, list.length - 120); i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    if (chunk.length < 3) continue;
    out.push({
      ts: chunk[0]?.ts,
      open: safeNum(chunk[0]?.open, chunk[0]?.close),
      close: safeNum(chunk.at(-1)?.close, chunk.at(-1)?.open),
      high: Math.max(...chunk.map((c) => safeNum(c?.high, c?.close))),
      low: Math.min(...chunk.map((c) => safeNum(c?.low, c?.close)))
    });
  }
  return out;
}

function buildMultiTimeframeDiagnostics({ sets = {}, action = "HOLD", regime = "" } = {}) {
  const c1 = Array.isArray(sets.candles1m) ? sets.candles1m : [];
  const c5 = Array.isArray(sets.candles5m) ? sets.candles5m : [];
  const c10 = Array.isArray(sets.candles10m) ? sets.candles10m : buildSynthetic10mCandles(c1);
  const closes5 = c5.map((c) => safeNum(c?.close, 0)).filter((x) => x > 0);
  const closes10 = c10.map((c) => safeNum(c?.close, 0)).filter((x) => x > 0);
  const momentum5mPips = slopePips(c5, 3);
  const momentum10mPips = slopePips(c10, 3);
  const trendSlope5mPips = slopePips(c5, 6);
  const trendSlope10mPips = slopePips(c10, 6);
  const rsi5m = computeSimpleRsiFromCloses(closes5, 14);
  const rsi10m = computeSimpleRsiFromCloses(closes10, 14);
  const bbZ5m = computeBbZFromCloses(closes5, 20);
  const bbZ10m = computeBbZFromCloses(closes10, 20);
  const dir = action === "BUY" ? 1 : (action === "SELL" ? -1 : 0);
  const alignRaw = dir === 0 ? 0 : ((momentum5mPips * dir) + (momentum10mPips * dir) + (trendSlope5mPips * dir) * 0.5 + (trendSlope10mPips * dir) * 0.5) / 6;
  const shortTermAlignmentScore = Number(clamp(0.5 + alignRaw / 2.5, 0, 1).toFixed(4));
  const exhaustionRaw = Math.max(
    0,
    action === "BUY"
      ? Math.max((rsi5m - 68) / 20, (rsi10m - 68) / 20, (bbZ5m - 1) / 1.4, (bbZ10m - 1) / 1.4)
      : Math.max((32 - rsi5m) / 20, (32 - rsi10m) / 20, (-bbZ5m - 1) / 1.4, (-bbZ10m - 1) / 1.4)
  );
  const shortTermExhaustionScore = Number(clamp(exhaustionRaw, 0, 1).toFixed(4));
  const regimeText = String(regime || "").toUpperCase();
  const alignmentWeight = regimeText === "RANGE" ? 0.35 : 0.55;
  const multiTimeframeScore = Number(clamp(
    0.5 + (shortTermAlignmentScore - 0.5) * alignmentWeight - shortTermExhaustionScore * 0.35,
    0,
    1
  ).toFixed(4));
  return {
    momentum5mPips,
    momentum10mPips,
    trendSlope5mPips,
    trendSlope10mPips,
    rsi5m,
    rsi10m,
    bbZ5m,
    bbZ10m,
    shortTermAlignmentScore,
    shortTermExhaustionScore,
    multiTimeframeScore
  };
}

function buildEntryLocationDiagnostics({ signal = {}, sets = {}, ticker = {}, mtf = {} } = {}) {
  const candles = Array.isArray(sets.candles1m) ? sets.candles1m : [];
  const pipSize = Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01));
  const action = String(signal.action || "HOLD");

  const tickerBid = positiveNum(ticker.bid, 0);
  const tickerAsk = positiveNum(ticker.ask, 0);
  const tickerMid = tickerBid > 0 && tickerAsk > 0
    ? (tickerBid + tickerAsk) / 2
    : positiveNum(ticker.mid, positiveNum(ticker.lastPrice, positiveNum(ticker.price, 0)));

  const lastCandleClose = positiveNum(candles.at(-1)?.close, positiveNum(candles.at(-1)?.open, 0));
  const sidePrice = action === "BUY"
    ? tickerAsk
    : (action === "SELL" ? tickerBid : tickerMid);

  const currentPrice = positiveNum(
    signal.entryPrice,
    positiveNum(sidePrice, positiveNum(tickerMid, lastCandleClose))
  );

  if (!(currentPrice > 0)) {
    return {
      entryLocationScore: 0.25,
      entryLocationCategory: "missingCurrentPrice",
      recentHigh: 0,
      recentLow: 0,
      currentPrice: 0,
      distanceFromRecentHighPips: 0,
      distanceFromRecentLowPips: 0,
      recentRunupPips: 0,
      recentRunupBars: 0,
      pullbackDepthPips: 0,
      pullbackConfirmed: false,
      validPullbackConfirmed: false,
      lateEntryDetected: false,
      overextendedEntry: false,
      expectedUpsidePips: 0,
      estimatedDownsidePips: 3,
      upsideDownsideRatio: 0,
      rsi1m: 50,
      bbZ1m: 0,
      rsi5m: mtf.rsi5m ?? 50,
      rsi10m: mtf.rsi10m ?? 50,
      bbZ5m: mtf.bbZ5m ?? 0,
      bbZ10m: mtf.bbZ10m ?? 0,
      reason: "missingCurrentPrice"
    };
  }

  const recent = candles.slice(-20);
  const runup = candles.slice(-5);
  const highs = recent.map((c) => safeNum(c?.high, c?.close)).filter((x) => x > 0);
  const lows = recent.map((c) => safeNum(c?.low, c?.close)).filter((x) => x > 0);
  const closes = candles.map((c) => safeNum(c?.close, 0)).filter((x) => x > 0);
  const recentHigh = highs.length ? Math.max(...highs) : currentPrice;
  const recentLow = lows.length ? Math.min(...lows) : currentPrice;
  const distanceFromRecentHighPips = Number(((recentHigh - currentPrice) / pipSize).toFixed(3));
  const distanceFromRecentLowPips = Number(((currentPrice - recentLow) / pipSize).toFixed(3));
  const recentRunupPips = runup.length >= 2
    ? Number(((safeNum(runup.at(-1)?.close, currentPrice) - safeNum(runup[0]?.close, currentPrice)) / pipSize).toFixed(3))
    : 0;
  const rsi1m = computeSimpleRsiFromCloses(closes, 14);
  const bbZ1m = computeBbZFromCloses(closes, 20);
  const stopPips = estimateStopLossPipsFromSignal(signal, currentPrice) || 1;
  const expectedUpsidePips = action === "BUY" ? Math.max(0, distanceFromRecentHighPips + 0.8) : Math.max(0, distanceFromRecentLowPips + 0.8);
  const estimatedDownsidePips = Math.max(0.5, stopPips);
  const upsideDownsideRatio = Number((expectedUpsidePips / estimatedDownsidePips).toFixed(4));
  const overextendedEntry = action === "BUY"
    ? (rsi1m >= 70 || bbZ1m >= 1 || recentRunupPips >= 1.6 || mtf.shortTermExhaustionScore >= 0.65)
    : (rsi1m <= 30 || bbZ1m <= -1 || recentRunupPips <= -1.6 || mtf.shortTermExhaustionScore >= 0.65);
  const pullbackDepthPips = action === "BUY" ? Math.max(0, recentHigh - currentPrice) / pipSize : Math.max(0, currentPrice - recentLow) / pipSize;
  const pullbackConfirmed = pullbackDepthPips >= 0.35 && mtf.shortTermAlignmentScore >= 0.48;
  const lateEntryDetected = overextendedEntry && !pullbackConfirmed;
  let entryLocationCategory = "neutralEntry";

  if (pullbackConfirmed && !overextendedEntry) entryLocationCategory = "validPullbackEntry";
  else if (lateEntryDetected) entryLocationCategory = "lateTrendEntry";
  else if (overextendedEntry) entryLocationCategory = "overextendedEntry";
  else if (String(signal.rationale || "").toLowerCase().includes("breakout")) entryLocationCategory = "breakoutEntry";
  else if (!pullbackConfirmed && String(signal.regime || "").toUpperCase().startsWith("TREND")) entryLocationCategory = "noPullbackEntry";

  const score = clamp(
    0.55
      + clamp((upsideDownsideRatio - 0.8) / 1.2, -0.3, 0.35)
      + (pullbackConfirmed ? 0.15 : 0)
      - (overextendedEntry ? 0.22 : 0)
      + (Number(mtf.multiTimeframeScore || 0.5) - 0.5) * 0.25,
    0,
    1
  );

  return {
    entryLocationScore: Number(score.toFixed(4)),
    entryLocationCategory,
    recentHigh,
    recentLow,
    currentPrice,
    distanceFromRecentHighPips,
    distanceFromRecentLowPips,
    recentRunupPips,
    recentRunupBars: runup.length,
    pullbackDepthPips: Number(pullbackDepthPips.toFixed(3)),
    pullbackConfirmed,
    validPullbackConfirmed: entryLocationCategory === "validPullbackEntry",
    lateEntryDetected,
    overextendedEntry,
    expectedUpsidePips: Number(expectedUpsidePips.toFixed(3)),
    estimatedDownsidePips: Number(estimatedDownsidePips.toFixed(3)),
    upsideDownsideRatio,
    rsi1m,
    bbZ1m,
    rsi5m: mtf.rsi5m,
    rsi10m: mtf.rsi10m,
    bbZ5m: mtf.bbZ5m,
    bbZ10m: mtf.bbZ10m,
    reason: entryLocationCategory
  };
}

function buildEntryEvidenceDiagnostics({ signal = {}, preTradeGuard = {}, contextValidation = {}, executionTailGate = {}, mtf = {}, entryLocation = {} } = {}) {
  const signalStrength = clamp(safeNum(signal.confidence, preTradeGuard.signalStrength ?? 0.5), 0, 1);
  const edgeAfterBuffer = safeNum(preTradeGuard.edgeAfterBuffer, 0);
  const edgeScore = clamp(0.5 + edgeAfterBuffer / 1.4, 0, 1);
  const executionStressPenalty = String(executionTailGate?.mode || "NORMAL").includes("BLOCK") ? 0.4 : clamp((1 - safeNum(executionTailGate?.tailPenaltyMultiplier, 1)), 0, 0.35);
  const spreadPenalty = clamp((safeNum(preTradeGuard.spreadPips, 0.2) - safeNum(preTradeGuard.spreadGatePips, 0.5)) / 0.5, 0, 0.25);
  const overextendedPenalty = entryLocation.overextendedEntry ? 0.22 : 0;
  const contextValidationScore = contextValidation?.allowed === false ? 0.1 : 0.75;
  const regimeScore = String(signal.regime || "").toUpperCase() === "HIGH_VOLATILITY" ? 0.25 : 0.62;
  const totalScore = clamp(
    regimeScore * 0.13
      + signalStrength * 0.20
      + edgeScore * 0.15
      + safeNum(mtf.multiTimeframeScore, 0.5) * 0.18
      + safeNum(mtf.shortTermAlignmentScore, 0.5) * 0.10
      + safeNum(entryLocation.entryLocationScore, 0.5) * 0.20
      + contextValidationScore * 0.08
      - safeNum(mtf.shortTermExhaustionScore, 0) * 0.10
      - overextendedPenalty
      - spreadPenalty
      - executionStressPenalty,
    0,
    1
  );
  let finalCategory = totalScore >= 0.75 ? "STRONG_BASE"
    : (totalScore >= 0.60 ? "PROBE_CANDIDATE"
      : (totalScore >= 0.45 ? "WEAK_HOLD" : "BLOCKED"));
  if (signal?.metrics?.decisionCategory === "BASE" && finalCategory !== "STRONG_BASE" && finalCategory !== "BLOCKED") {
    finalCategory = "BASE";
  }
  const probeBlockedReasons = [];
  if (String(signal.regime || "").toUpperCase() === "HIGH_VOLATILITY") probeBlockedReasons.push("high_volatility");
  if (executionTailGate?.blocked) probeBlockedReasons.push("execution_tail_blocked");
  if (preTradeGuard?.allowed === false) probeBlockedReasons.push("pre_trade_guard");
  if (entryLocation.overextendedEntry && totalScore < 0.7) probeBlockedReasons.push("overextended");
  return {
    entryEvidenceScore: Number(totalScore.toFixed(4)),
    entryEvidenceBreakdown: {
      totalScore: Number(totalScore.toFixed(4)),
      regimeScore: Number(regimeScore.toFixed(4)),
      signalStrengthScore: Number(signalStrength.toFixed(4)),
      edgeAfterBufferScore: Number(edgeScore.toFixed(4)),
      multiTimeframeScore: safeNum(mtf.multiTimeframeScore, 0.5),
      shortTermAlignmentScore: safeNum(mtf.shortTermAlignmentScore, 0.5),
      shortTermExhaustionPenalty: safeNum(mtf.shortTermExhaustionScore, 0),
      trendUpEntryQualityScore: safeNum(entryLocation.entryLocationScore, 0.5),
      overextendedPenalty,
      spreadPenalty: Number(spreadPenalty.toFixed(4)),
      executionStressPenalty: Number(executionStressPenalty.toFixed(4)),
      contextValidationScore,
      recentContextPfScore: 0,
      oosWfaScore: 0,
      finalCategory
    },
    finalCategory,
    probeLowRateEligible: finalCategory === "PROBE_CANDIDATE" && probeBlockedReasons.length === 0,
    probeBlockedReasons
  };
}

function buildDecisionTrace({ signal = {}, finalAction = "HOLD", finalReason = "", mtf = {}, evidence = {}, entryLocation = {}, preTradeGuard = {}, reentryGuard = {}, positionSizingDiagnostics = {}, executionTailGate = {} } = {}) {
    return {
        timestamp: new Date().toISOString(),
        executionMode: normalizeAutoExecutionMode(loadState().settings?.autoExecutionMode),
        symbol: "USDJPY",
        price: positiveNum(signal.entryPrice, positiveNum(entryLocation.currentPrice, 0)),
        candidateAction: signal.action || "HOLD",
        finalAction,
        finalReason,
        stages: [
            { name: "market_input", status: "pass", details: {} },
            { name: "signal_generation", status: signal.action === "HOLD" ? "hold" : "pass", details: { rationale: signal.rationale || null } },
            { name: "multi_timeframe", status: safeNum(mtf.multiTimeframeScore, 0.5) >= 0.45 ? "pass" : "warning", details: mtf },
            { name: "entry_evidence", status: evidence.finalCategory === "STRONG_BASE" ? "pass" : (evidence.probeLowRateEligible ? "probe" : "blocked"), details: evidence.entryEvidenceBreakdown || {} },
            { name: "trend_up_entry_quality", status: entryLocation.lateEntryDetected ? "warning" : "pass", details: entryLocation },
            { name: "pre_trade_guard", status: preTradeGuard.allowed === false ? "blocked" : "pass", details: preTradeGuard },
            { name: "reentry_guard", status: reentryGuard.blocked ? (reentryGuard.downgradedToProbeLowRate ? "probe" : "blocked") : "pass", details: reentryGuard },
            { name: "position_sizing", status: positionSizingDiagnostics.blockedReason ? "blocked" : (positionSizingDiagnostics.cappedByMaxUnits || positionSizingDiagnostics.cappedByLeverage ? "capped" : "pass"), details: positionSizingDiagnostics },
            { name: "execution_tail_gate", status: executionTailGate.blocked ? "blocked" : (safeNum(executionTailGate.tailPenaltyMultiplier, 1) < 0.8 ? "warning" : "pass"), details: executionTailGate },
            { name: "final_decision", status: finalAction === "OPEN" ? "trade" : (finalAction === "PROBE" ? "probe" : "hold"), details: { finalReason } }
        ]
    };
}

function buildNoActionableSignalDiagnostics({ signal = {}, sets = {}, mtf = {}, entryLocation = {}, evidence = {} } = {}) {
    const candles = Array.isArray(sets.candles1m) ? sets.candles1m : [];
    const recent = candles.slice(-24);
    const pipSize = Math.max(0.0001, Number(RUNTIME_CONFIG.pipSize || 0.01));
    const highs = recent.map((c) => safeNum(c?.high, c?.close)).filter((x) => x > 0);
    const lows = recent.map((c) => safeNum(c?.low, c?.close)).filter((x) => x > 0);
    const rangeHigh = highs.length ? Math.max(...highs) : 0;
    const rangeLow = lows.length ? Math.min(...lows) : 0;
    const actualRangeWidthPips = rangeHigh > rangeLow ? Number(((rangeHigh - rangeLow) / pipSize).toFixed(3)) : 0;
    const allowedRangeWidthPips = Math.max(2, safeNum(RUNTIME_CONFIG.range?.maxWidthPips, 8));
    const category = evidence.probeLowRateEligible ? "PROBE_CANDIDATE"
        : (entryLocation.overextendedEntry ? "OVEREXTENDED"
            : (safeNum(mtf.multiTimeframeScore, 0.5) < 0.4 ? "MULTI_TIMEFRAME_MISMATCH"
                : (actualRangeWidthPips > allowedRangeWidthPips ? "RANGE_TOO_WIDE" : "NO_EDGE")));
    return {
        reason: signal.rationale || "no actionable signal",
        category,
        blockedBeforePreTradeGuard: true,
        candidateSide: signal.action || "HOLD",
        regime: signal.regime || "UNKNOWN",
        actualRangeWidthPips,
        allowedRangeWidthPips,
        rangeWidthRatio: allowedRangeWidthPips > 0 ? Number((actualRangeWidthPips / allowedRangeWidthPips).toFixed(4)) : 0,
        rangeLookbackBars: recent.length,
        rangeHigh,
        rangeLow,
        currentPrice: positiveNum(entryLocation.currentPrice, 0),
        entryConditionFailedReasons: [category],
        entryEvidenceScore: evidence.entryEvidenceScore || 0,
        probeLowRateEligible: Boolean(evidence.probeLowRateEligible),
        probeBlockedReasons: evidence.probeBlockedReasons || [],
        multiTimeframeScore: mtf.multiTimeframeScore,
        shortTermAlignmentScore: mtf.shortTermAlignmentScore,
        shortTermExhaustionScore: mtf.shortTermExhaustionScore,
        trendUpEntryQuality: entryLocation,
        timestamp: new Date().toISOString()
    };
}

function runLearningOps(state) {
  maybeRefreshLearningMemory(state);
  maybeRefreshExecutionCalibration(state);
  maybeAutoSnapshot(state);
  maybeAutoRollback(state);
}

function maybeRefreshLearningMemory(state) {
  if (!Boolean(RUNTIME_CONFIG.learningMemory?.enabled ?? true)) return;
  autoRuntime.learningMemory = updateLearningMemoryFromTrades(state.trades || [], {
    alpha: Number(RUNTIME_CONFIG.learningMemory?.ewmaAlpha || 0.02),
    maxContexts: Number(RUNTIME_CONFIG.learningMemory?.maxContexts || 3000)
  });
}

function maybeRefreshExecutionCalibration(state) {
  const nowMs = Date.now();
  const prevAt = Number(autoRuntime.executionCalibration?.updatedAtMs || 0);
  if (nowMs - prevAt < 5 * 60 * 1000) return;
  const prevRecal = Number(autoRuntime.executionCalibration?.lastRecalibratedAtMs || 0);
  const weeklyMs = 7 * 24 * 60 * 60 * 1000;
  const mustWeeklyRecalibrate = !prevRecal || (nowMs - prevRecal >= weeklyMs);
  let calibration = autoRuntime.executionCalibration || {};
  if (mustWeeklyRecalibrate) {
    const telemetry = listExecutionTelemetry(Math.max(1000, Number(RUNTIME_CONFIG.executionCalibration?.telemetryLookbackRecords || 5000)));
    calibration = computeExecutionCalibrationFromTelemetry(telemetry, RUNTIME_CONFIG.executionCalibration || {});
    if (!calibration.ready) {
      calibration = computeExecutionCalibration(state, RUNTIME_CONFIG.executionCalibration || {});
    }
    calibration.lastRecalibratedAtMs = nowMs;
  } else if (!Boolean(calibration?.ready)) {
    calibration = computeExecutionCalibration(state, RUNTIME_CONFIG.executionCalibration || {});
  }
  autoRuntime.executionCalibration = {
    ...calibration,
    updatedAtMs: nowMs
  };
}

function maybeAutoSnapshot(state) {
  const cfg = RUNTIME_CONFIG.rlBandit?.ops || {};
  const everyTrades = Math.max(5, Number(cfg.autoSnapshotEveryTrades || 25));
  const minIntervalMs = Math.max(1, Number(cfg.autoSnapshotMinIntervalMin || 15)) * 60 * 1000;
  const nowMs = Date.now();
  const tradeCount = Array.isArray(state.trades) ? state.trades.length : 0;
  if (tradeCount < everyTrades) return;
  const deltaTrades = tradeCount - Number(autoRuntime.lastSnapshotTradeCount || 0);
  const deltaMs = nowMs - Number(autoRuntime.lastSnapshotAtMs || 0);
  if (deltaTrades < everyTrades && deltaMs < minIntervalMs) return;
  try {
    const out = createPolicySnapshot(`auto-${tradeCount}`);
    autoRuntime.lastSnapshotAtMs = nowMs;
    autoRuntime.lastSnapshotTradeCount = tradeCount;
    withState((s) => appendAudit(s, "learning.snapshot.auto", {
      id: out.id,
      label: out.label,
      trades: tradeCount
    }));
  } catch (error) {
    withState((s) => appendAudit(s, "learning.snapshot.error", {
      message: String(error?.message || error)
    }));
  }
}

function maybeAutoRollback(state) {
  const cfg = RUNTIME_CONFIG.rlBandit?.ops || {};
  const nowMs = Date.now();
  const minIntervalMs = Math.max(1, Number(cfg.rollbackMinIntervalMin || 30)) * 60 * 1000;
  if (nowMs - Number(autoRuntime.lastRollbackAtMs || 0) < minIntervalMs) return;
  const lookback = Math.max(10, Number(cfg.rollbackLookbackTrades || 40));
  const minTrades = Math.max(5, Number(cfg.rollbackMinTrades || 20));
  const floorWin = clamp(Number(cfg.rollbackWinRateFloor || 0.34), 0.1, 0.9);
  const floorLoss = Number(cfg.rollbackNetLossFloorJpy || -50000);
  const recent = (state.trades || []).slice(-lookback);
  if (recent.length < minTrades) return;
  const wins = recent.filter((t) => Number(t.netPnlJpy) > 0).length;
  const net = recent.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0);
  const winRate = wins / recent.length;
  if (!(winRate < floorWin || net <= floorLoss)) return;

  const snapshots = listPolicySnapshots();
  if (!snapshots.length) return;
  const latest = snapshots[0];
  const restored = restorePolicySnapshot(latest.id);
  if (!restored) return;
  autoRuntime.lastRollbackAtMs = nowMs;
  autoRuntime.rollbackWarmupUntilMs = nowMs + 60 * 60 * 1000;
  withState((s) => appendAudit(s, "learning.rollback.auto", {
    id: restored.id,
    label: restored.label,
    reason: "degraded_recent_performance",
    winRate: Number(winRate.toFixed(4)),
    netPnlJpy: Number(net.toFixed(2)),
    lookbackTrades: recent.length
  }));
}

function evaluateAnomalyControl(state, ticker) {
  const nowMs = Date.now();
  const cfg = RUNTIME_CONFIG.anomalyGate || {};
  const blockDurationMs = Math.max(5, Number(cfg.blockDurationSec || 120)) * 1000;
  const reducedDurationMs = Math.max(5, Number(cfg.reducedDurationSec || 180)) * 1000;
  const reducedSizeMultiplier = clamp(Number(cfg.reducedSizeMultiplier || 0.35), 0.05, 1);
  const raw = detectAnomalyBlock(state, ticker);

  if (raw.blocked) {
    autoRuntime.anomalyMode = "BLOCK";
    autoRuntime.anomalyModeUntilMs = nowMs + blockDurationMs;
    return { ...raw, mode: "BLOCK", sizeMultiplier: 0 };
  }

  if (autoRuntime.anomalyMode === "BLOCK") {
    if (nowMs < Number(autoRuntime.anomalyModeUntilMs || 0)) {
      return {
        blocked: true,
        reason: `異常保護中: 復帰待ち ${Math.max(1, Math.ceil((autoRuntime.anomalyModeUntilMs - nowMs) / 1000))}秒`,
        mode: "BLOCK",
        sizeMultiplier: 0
      };
    }
    autoRuntime.anomalyMode = "REDUCED";
    autoRuntime.anomalyModeUntilMs = nowMs + reducedDurationMs;
    return {
      blocked: false,
      reason: "異常復帰: 取引数量を縮小して再開",
      mode: "REDUCED",
      sizeMultiplier: reducedSizeMultiplier
    };
  }

  if (autoRuntime.anomalyMode === "REDUCED") {
    if (nowMs < Number(autoRuntime.anomalyModeUntilMs || 0)) {
      return {
        blocked: false,
        reason: "異常復帰中: 取引数量を縮小",
        mode: "REDUCED",
        sizeMultiplier: reducedSizeMultiplier
      };
    }
    autoRuntime.anomalyMode = "NORMAL";
    autoRuntime.anomalyModeUntilMs = 0;
  }

  return {
    blocked: false,
    reason: null,
    mode: "NORMAL",
    sizeMultiplier: 1
  };
}

function evaluateExecutionTailGate(nowMs) {
  const cfgBase = RUNTIME_CONFIG.auto?.executionTailGate || {};
  const penaltyBase = RUNTIME_CONFIG.auto?.tailPenalty || {};
  const session = detectUsdJpySession(new Date(nowMs).toISOString());
  const cfg = {
    ...cfgBase,
    ...((cfgBase.bySession && cfgBase.bySession[session]) || {})
  };
  const penaltyCfg = {
    ...penaltyBase,
    ...((penaltyBase.bySession && penaltyBase.bySession[session]) || {})
  };
  if (!Boolean(cfg.enabled)) {
    return {
      enabled: false,
      blocked: false,
      pending: false,
      reason: "execution tail gate disabled",
      riskMultiplier: 1,
      tailPenaltyMultiplier: 1
    };
  }
  const guardUntilMs = Number(autoRuntime.executionTailGuardUntilMs || 0);
  if (guardUntilMs > nowMs) {
    return {
      enabled: true,
      blocked: true,
      pending: false,
      mode: "COOLDOWN",
      reason: autoRuntime.executionTailGuardReason || `execution tail cooldown (${Math.ceil((guardUntilMs - nowMs) / 1000)}s)`,
      riskMultiplier: 0,
      tailPenaltyMultiplier: Number(penaltyCfg.minMultiplier || 0.35),
      session
    };
  }
  autoRuntime.executionTailGuardUntilMs = 0;
  autoRuntime.executionTailGuardReason = null;

  const lookback = Math.max(200, Number(cfg.lookbackRecords || 1500));
  const minSamples = Math.max(30, Number(cfg.minSamples || 80));
  const avgPipelineLimit = Math.max(50, Number(cfg.avgPipelineLatencyMsLimit || 650));
  const p95PipelineLimit = Math.max(avgPipelineLimit, Number(cfg.p95PipelineLatencyMsLimit || 900));
  const p99PipelineLimit = Math.max(p95PipelineLimit, Number(cfg.p99PipelineLatencyMsLimit || 1200));
  const rejectRateLimit = clamp(Number(cfg.rejectRateLimit || 0.1), 0.01, 0.5);
  const slippageMultiplier = Math.max(1.1, Number(cfg.slippageP95Multiplier || 2.8));
  const stats = getExecutionTelemetryStats({ lookback });
  if (Number(stats.sampleSize || 0) < minSamples) {
    return {
      enabled: true,
      blocked: false,
      pending: true,
      reason: `execution tail gate pending: ${stats.sampleSize || 0}/${minSamples}`,
      riskMultiplier: 1,
      tailPenaltyMultiplier: 1,
      session,
      stats
    };
  }
  const targetSlip = Math.max(0.05, Number(RUNTIME_CONFIG.executionCalibration?.targetSlippagePips || 0.28));
  const slippageP95Limit = Number((targetSlip * slippageMultiplier).toFixed(4));
  const tailPenaltyMultiplier = computeTailPenaltyMultiplier({
    p95PipelineLatencyMs: Number(stats.p95PipelineLatencyMs || 0),
    p99PipelineLatencyMs: Number(stats.p99PipelineLatencyMs || 0),
    rejectRate: Number(stats.rejectRate || 0),
    p95SlippagePips: Number(stats.p95SlippagePips || 0),
    targetSlippagePips: targetSlip,
    cfg: penaltyCfg
  });
  if (Number(stats.avgPipelineLatencyMs || 0) > avgPipelineLimit) {
    return {
      enabled: true,
      blocked: true,
      pending: false,
      mode: "AVG_BLOCK",
      reason: `execution tail block: avg pipeline ${stats.avgPipelineLatencyMs}ms > ${avgPipelineLimit}ms`,
      riskMultiplier: 0,
      tailPenaltyMultiplier,
      session,
      stats
    };
  }
  if (Number(stats.rejectRate || 0) > rejectRateLimit) {
    return {
      enabled: true,
      blocked: true,
      pending: false,
      mode: "REJECT_BLOCK",
      reason: `execution tail block: reject rate ${(Number(stats.rejectRate || 0) * 100).toFixed(2)}% > ${(rejectRateLimit * 100).toFixed(2)}%`,
      riskMultiplier: 0,
      tailPenaltyMultiplier,
      session,
      stats
    };
  }
  if (Number(stats.p95SlippagePips || 0) > slippageP95Limit) {
    return {
      enabled: true,
      blocked: true,
      pending: false,
      mode: "SLIPPAGE_BLOCK",
      reason: `execution tail block: p95 slippage ${stats.p95SlippagePips} > ${slippageP95Limit} pips`,
      riskMultiplier: 0,
      tailPenaltyMultiplier,
      session,
      stats
    };
  }
  const p99SoftWarning = Number(stats.p99PipelineLatencyMs || 0) > p99PipelineLimit;
  return {
    enabled: true,
    blocked: false,
    pending: false,
    mode: p99SoftWarning ? "P99_SOFT_WARNING" : "NORMAL",
    reason: p99SoftWarning
      ? `execution tail soft warning: p99 pipeline ${stats.p99PipelineLatencyMs}ms > ${p99PipelineLimit}ms`
      : "execution tail normal",
    riskMultiplier: 1,
    tailPenaltyMultiplier,
    session,
    stats
  };
}

function evaluateNoTradeZone({ ticker, signal, nowMs }) {
  const cfg = RUNTIME_CONFIG.auto?.noTradeZone || {};
  const schedule = evaluateNoTradeZoneSchedule(ticker?.ts || new Date(nowMs).toISOString(), cfg);
  const cond = cfg.conditionalMode || {};
  const tailGate = autoRuntime.lastExecutionTailGate || {};
  const tail = tailGate.stats || {};
  const targetSlip = Math.max(0.05, Number(RUNTIME_CONFIG.executionCalibration?.targetSlippagePips || 0.28));
  const rejectRate = Number(tail.rejectRate || 0);
  const tailPenaltyMultiplier = Number(autoRuntime.lastExecutionTailGate?.tailPenaltyMultiplier || 1);
  const tailSamples = Number(tail.sampleSize || 0);
  const minTailSamples = Math.max(1, Number(cond.minTailSamplesForHardBlock || 30));
  const tailDegradedRaw = rejectRate >= Number(cond.tailRejectRateBlock || 0.1)
    || Number(tail.p95PipelineLatencyMs || 0) >= Number(cond.tailP95LatencyBlockMs || 1050)
    || Number(tail.p95SlippagePips || 0) >= targetSlip * Number(cond.tailSlippageBlockMultiplier || 2.8)
    || tailPenaltyMultiplier < Number(cond.tailPenaltyHardBlock || 0.55);
  const tailDegraded = Boolean(!tailGate.pending && tailSamples >= minTailSamples && tailDegradedRaw);
  const activeEventCount = Array.isArray(signal?.news?.activeEventIds) ? signal.news.activeEventIds.length : 0;
  // P0: avoid permanent event lock from stale high-impact history; prioritize active windows.
  const highImpact = Boolean(signal?.news?.shortTermRiskLock || activeEventCount > 0);
  if (schedule.blocked) return schedule;
  // P0: no-trade zone defaults to size-down; hard block only on event + strong tail degradation.
  if (highImpact && Boolean(cond.enabled) && tailDegraded) {
    return {
      enabled: true,
      blocked: true,
      sizeMultiplier: 0,
      reasonCode: "EVENT_TAIL_HARD_BLOCK",
      reason: "no-trade zone: high-impact event + degraded execution"
    };
  }
  if (highImpact) {
    return {
      enabled: true,
      blocked: false,
      sizeMultiplier: clamp(Number(cond.highImpactSizeDownMultiplier || 0.4), 0.1, 1),
      reasonCode: "EVENT_SIZE_DOWN",
      reason: "no-trade zone: high-impact event (size down)"
    };
  }
  if (Boolean(cond.enabled) && tailDegraded && Number(schedule.sizeMultiplier || 1) >= 1) {
    return {
      enabled: true,
      blocked: false,
      sizeMultiplier: clamp(Number(cfg.sizeDownMultiplier || 0.6), 0.1, 1),
      reasonCode: "TAIL_SIZE_DOWN",
      reason: "no-trade zone: degraded execution (size down)"
    };
  }
  return schedule;
}

function detectAnomalyBlock(state, ticker) {
  const cfg = RUNTIME_CONFIG.anomalyGate || {};
  const spread = Number(ticker?.spreadPips || 0);
  const spreadLimit = Number(cfg.spreadPipsHardLimit || 0.55);
  if (spread > spreadLimit) {
    return {
      blocked: true,
      reason: `異常: スプレッド拡大 ${spread.toFixed(3)}pips`,
      spreadPips: spread
    };
  }

  const nowMs = Date.now();
  const rejectWindowMs = Math.max(10, Number(cfg.rejectWindowSec || 120)) * 1000;
  const rejectLimit = Math.max(1, Number(cfg.rejectCountLimit || 3));
  const recentRejects = (state.auditLogs || []).filter((a) =>
    a?.event === "auto.order.rejected" && (nowMs - new Date(a.ts).getTime()) <= rejectWindowMs
  ).length;
  if (recentRejects >= rejectLimit) {
    return {
      blocked: true,
      reason: `異常: 約定拒否が連続 (${recentRejects}件)`,
      rejectCount: recentRejects
    };
  }

  const spikeWindowMs = Math.max(10, Number(cfg.newsSpikeWindowSec || 300)) * 1000;
  const spikeLimit = Math.max(1, Number(cfg.newsSpikeCountLimit || 8));
  const newsSpike = (state.newsEvents || []).filter((n) => (nowMs - new Date(n.ts).getTime()) <= spikeWindowMs).length;
  if (newsSpike >= spikeLimit) {
    return {
      blocked: true,
      reason: `異常: ニュース急増 (${newsSpike}件/${Math.round(spikeWindowMs / 1000)}秒)`,
      newsCount: newsSpike
    };
  }

  return { blocked: false };
}

// P1: LIVE移行は実測KPIで判定し、未達なら本番開始を拒否。
function evaluateLiveReadiness(state) {
  const cfg = RUNTIME_CONFIG.auto?.liveGoNoGo || {};
  const enabled = Boolean(cfg.enabled ?? true);
  const minAutoTrades = Math.max(20, Number(cfg.minAutoTrades || 200));
  const minTelemetrySamples = Math.max(50, Number(cfg.minTelemetrySamples || 150));
  const minProfitFactor = Math.max(0.8, Number(cfg.minProfitFactor || 1.05));
  const maxDrawdownRatio = clamp(Number(cfg.maxDrawdownRatio || 0.08), 0.01, 0.4);
  const maxP95PipelineLatencyMs = Math.max(200, Number(cfg.maxP95PipelineLatencyMs || 900));
  const maxRejectRate = clamp(Number(cfg.maxRejectRate || 0.08), 0.01, 0.5);
  const maxP95SlippagePips = Math.max(0.05, Number(cfg.maxP95SlippagePips || 0.56));
  const blockers = [];

  if (!enabled) {
    return { enabled: false, ready: true, reason: "live gating disabled", blockers: [] };
  }
  if (!hasLiveOrderExecutionConfig()) blockers.push("live_order_config_missing");

  const trades = (Array.isArray(state?.trades) ? state.trades : [])
    .filter((t) => String(t?.exitReason || "").startsWith("auto-"));
  const autoTrades = trades.length;
  if (autoTrades < minAutoTrades) blockers.push(`auto_trades_short:${autoTrades}/${minAutoTrades}`);

  const summary = analyticsSummary(trades);
  const profitFactor = Number(summary?.profitFactor || 0);
  if (autoTrades >= Math.max(20, Math.floor(minAutoTrades * 0.5)) && profitFactor > 0 && profitFactor < minProfitFactor) {
    blockers.push(`profit_factor_low:${profitFactor.toFixed(3)}<${minProfitFactor.toFixed(3)}`);
  }

  const initial = Math.max(1, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const current = Math.max(0, Number(state?.account?.currentBalanceJpy || initial));
  const ddRatio = current < initial ? (initial - current) / initial : 0;
  if (ddRatio > maxDrawdownRatio) blockers.push(`drawdown_high:${(ddRatio * 100).toFixed(2)}%>${(maxDrawdownRatio * 100).toFixed(2)}%`);

  const telemetryLookback = Math.max(300, Number(RUNTIME_CONFIG.auto?.executionTailGate?.lookbackRecords || 1500));
  const ex = getExecutionTelemetryStats({ lookback: telemetryLookback });
  const sampleSize = Number(ex?.sampleSize || 0);
  if (sampleSize < minTelemetrySamples) blockers.push(`telemetry_short:${sampleSize}/${minTelemetrySamples}`);
  if (sampleSize > 0 && Number(ex.p95PipelineLatencyMs || 0) > maxP95PipelineLatencyMs) {
    blockers.push(`p95_latency_high:${Number(ex.p95PipelineLatencyMs || 0)}>${maxP95PipelineLatencyMs}`);
  }
  if (sampleSize > 0 && Number(ex.rejectRate || 0) > maxRejectRate) {
    blockers.push(`reject_rate_high:${(Number(ex.rejectRate || 0) * 100).toFixed(2)}%>${(maxRejectRate * 100).toFixed(2)}%`);
  }
  if (sampleSize > 0 && Number(ex.p95SlippagePips || 0) > maxP95SlippagePips) {
    blockers.push(`p95_slippage_high:${Number(ex.p95SlippagePips || 0).toFixed(3)}>${maxP95SlippagePips.toFixed(3)}`);
  }

  return {
    enabled: true,
    ready: blockers.length === 0,
    reason: blockers.length ? "LIVE条件未達" : "LIVE開始条件を満たしています",
    blockers,
    metrics: {
      autoTrades,
      profitFactor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(4)) : null,
      ddRatio: Number(ddRatio.toFixed(6)),
      telemetrySamples: sampleSize,
      p95PipelineLatencyMs: Number(ex.p95PipelineLatencyMs || 0),
      rejectRate: Number(ex.rejectRate || 0),
      p95SlippagePips: Number(ex.p95SlippagePips || 0)
    },
    thresholds: {
      minAutoTrades,
      minTelemetrySamples,
      minProfitFactor,
      maxDrawdownRatio,
      maxP95PipelineLatencyMs,
      maxRejectRate,
      maxP95SlippagePips
    }
  };
}

function hasLiveOrderExecutionConfig() {
  if (String(BROKER_ORDER_MODE || "").toUpperCase() !== "LIVE_HTTP") return false;
  if (!BROKER_ORDER_LIVE_MANUAL) return false;
  if (BROKER_ORDER_PROVIDER === "GMO_FX") return Boolean(GMO_FX_API_KEY && GMO_FX_API_SECRET);
  return Boolean(BROKER_ORDER_HTTP_URL);
}

function evaluateBenchmarkGate(state) {
  const cfg = RUNTIME_CONFIG.benchmark || {};
  if (!cfg.enforceForAuto) return { allowed: true };
  const report = analyticsValidationReport200(state.trades || [], cfg);
  if (!report.ok) {
    return {
      allowed: false,
      reason: `ベンチ判定待ち: ${report.available || 0}/${report.requirement || cfg.minTrades}`
    };
  }
  if (!report.pass) {
    return {
      allowed: false,
      reason: "ベンチ未達のため自動抑制"
    };
  }
  return { allowed: true };
}

function getRuntimeExecutionConfig() {
  const cfg = JSON.parse(JSON.stringify(RUNTIME_CONFIG));
  const cal = autoRuntime.executionCalibration || {};
  if (!Boolean(cal.ready)) return cfg;
  cfg.execution.rejectProbability = clamp(
    Number(cfg.execution.rejectProbability || 0) + Number(cal.rejectRateAdj || 0),
    0.001,
    0.25
  );
  cfg.execution.maxSlippagePips = clamp(
    Number(cfg.execution.maxSlippagePips || 0.8) * Number(cal.slippageAdj || 1),
    0.08,
    3
  );
  cfg.execution.baseLatencyMs = Math.round(clamp(
    Number(cfg.execution.baseLatencyMs || 120) * Number(cal.latencyAdj || 1),
    20,
    1800
  ));
  return cfg;
}

async function executeOrderLifecycle({ side, qty, requestedPrice, marketTick, executionConfig, allowLive }) {
  const mode = String(BROKER_ORDER_MODE || "SIMULATED").toUpperCase();
  if (!allowLive || mode !== "LIVE_HTTP") {
    return simulateOrderLifecycle({
      side,
      qty,
      requestedPrice,
      market: marketTick,
      config: executionConfig
    });
  }
  try {
    if (BROKER_ORDER_PROVIDER === "GMO_FX") {
      return await executeGmoFxLiveOrder({ side, qty, requestedPrice, marketTick, executionConfig });
    }
    if (!BROKER_ORDER_HTTP_URL) {
      throw new Error("BROKER_ORDER_HTTP_URL is missing");
    }
    return await executeGenericLiveOrder({ side, qty, requestedPrice, marketTick, executionConfig });
  } catch (error) {
    return buildRejectedLiveLifecycle({
      side,
      qty,
      requestedPrice,
      reason: String(error?.message || error)
    });
  }
}

async function executeGenericLiveOrder({ side, qty, requestedPrice, marketTick, executionConfig }) {
  const started = Date.now();
  const payload = {
    symbol: BROKER_ORDER_SYMBOL,
    side,
    size: Number(qty),
    executionType: "MARKET",
    ...(Number(requestedPrice) > 0 ? { price: Number(requestedPrice) } : {})
  };
  const res = await fetchWithTimeout(BROKER_ORDER_HTTP_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...BROKER_ORDER_HEADERS
    },
    body: JSON.stringify(payload)
  }, BROKER_ORDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`live order status ${res.status}`);
  const parsed = await parseResponsePayload(res);
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  return buildFilledLiveLifecycle({
    side,
    qty,
    requestedPrice,
    marketTick,
    executionConfig,
    latencyMs: Date.now() - started,
    venueOrderId: data?.orderId || data?.id || null,
    fillPrice: Number(data?.price ?? data?.executionPrice ?? data?.averagePrice ?? NaN),
    executedQty: Number(data?.size ?? data?.executedSize ?? qty),
    feeJpy: Number(data?.fee ?? data?.feeJpy ?? 0)
  });
}

async function executeGmoFxLiveOrder({ side, qty, requestedPrice, marketTick, executionConfig }) {
  if (!(GMO_FX_API_KEY && GMO_FX_API_SECRET)) {
    throw new Error("GMO_FX_API_KEY / GMO_FX_API_SECRET is missing");
  }
  const started = Date.now();
  const path = GMO_FX_ORDER_PATH.startsWith("/") ? GMO_FX_ORDER_PATH : `/${GMO_FX_ORDER_PATH}`;
  const url = `${GMO_FX_API_BASE_URL.replace(/\/$/, "")}${path}`;
  const payload = {
    symbol: BROKER_ORDER_SYMBOL,
    side,
    executionType: "MARKET",
    size: Number(qty).toFixed(3),
    ...(Number(requestedPrice) > 0 ? { price: Number(requestedPrice).toFixed(3) } : {})
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signBase = `${timestamp}POST${path}${body}`;
  const signature = createHmac("sha256", GMO_FX_API_SECRET).update(signBase).digest("hex");
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [GMO_FX_HEADER_KEY]: GMO_FX_API_KEY,
      [GMO_FX_HEADER_TIMESTAMP]: timestamp,
      [GMO_FX_HEADER_SIGN]: signature
    },
    body
  }, BROKER_ORDER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`gmo live order status ${res.status}`);
  const parsed = await parseResponsePayload(res);
  const data = parsed?.data && typeof parsed.data === "object"
    ? parsed.data
    : (Array.isArray(parsed?.data) ? parsed.data[0] : parsed);
  return buildFilledLiveLifecycle({
    side,
    qty,
    requestedPrice,
    marketTick,
    executionConfig,
    latencyMs: Date.now() - started,
    venueOrderId: data?.orderId || data?.id || null,
    fillPrice: Number(data?.price ?? data?.executionPrice ?? data?.averagePrice ?? NaN),
    executedQty: Number(data?.size ?? data?.executedSize ?? qty),
    feeJpy: Number(data?.fee ?? data?.feeJpy ?? 0)
  });
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(500, Number(timeoutMs || 6000)));
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function parseResponsePayload(res) {
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) return await res.json();
  return JSON.parse(await res.text());
}

function buildFilledLiveLifecycle({ side, qty, requestedPrice, marketTick, executionConfig, latencyMs, venueOrderId, fillPrice, executedQty, feeJpy }) {
  const orderId = randomUUID();
  const nowIso = new Date().toISOString();
  const bestQuote = side === "BUY" ? Number(marketTick.ask || 0) : Number(marketTick.bid || 0);
  const safePrice = Number.isFinite(fillPrice) && fillPrice > 0 ? Number(fillPrice) : bestQuote;
  const safeQty = Math.max(0, Number.isFinite(executedQty) ? Number(executedQty) : Number(qty));
  if (!(safeQty > 0) || !(safePrice > 0)) {
    return buildRejectedLiveLifecycle({ side, qty, requestedPrice, reason: "live fill data invalid", latencyMs });
  }
  const statusHistory = [
    { status: "NEW", ts: nowIso },
    { status: "PENDING", ts: nowIso },
    { status: "FILLED", ts: nowIso }
  ];
  const slippagePips = Number((((safePrice - bestQuote) / Number(executionConfig?.pipSize || 0.01)) * (side === "BUY" ? 1 : -1)).toFixed(3));
  const fee = Number(Number(feeJpy || 0).toFixed(2));
  return {
    order: {
      id: orderId,
      side,
      qty: Number(qty),
      requestedPrice,
      status: "FILLED",
      createdAt: nowIso,
      statusHistory,
      venueOrderId
    },
    fills: [{
      id: randomUUID(),
      orderId,
      qty: safeQty,
      price: Number(safePrice.toFixed(3)),
      slippagePips,
      feeJpy: fee,
      latencyMs: Math.max(1, Math.round(Number(latencyMs || 0))),
      ts: nowIso
    }],
    executedQty: Number(safeQty.toFixed(3)),
    avgFillPrice: Number(safePrice.toFixed(3)),
    feeJpy: fee,
    slippagePips,
    latencyMs: Math.max(1, Math.round(Number(latencyMs || 0))),
    rejected: false
  };
}

function buildRejectedLiveLifecycle({ side, qty, requestedPrice, reason, latencyMs = 0 }) {
  const nowIso = new Date().toISOString();
  const statusHistory = [
    { status: "NEW", ts: nowIso },
    { status: "PENDING", ts: nowIso },
    { status: "REJECTED", ts: nowIso }
  ];
  return {
    order: {
      id: randomUUID(),
      side,
      qty: Number(qty),
      requestedPrice,
      status: "REJECTED",
      createdAt: nowIso,
      statusHistory,
      rejectReason: reason
    },
    fills: [],
    executedQty: 0,
    avgFillPrice: null,
    feeJpy: 0,
    slippagePips: 0,
    latencyMs: Math.max(1, Math.round(Number(latencyMs || 0))),
    rejected: true
  };
}

function getRuntimeLearningConfig() {
  const nowMs = Date.now();
  const cfg = JSON.parse(JSON.stringify(RUNTIME_CONFIG));
  if (nowMs < Number(autoRuntime.rollbackWarmupUntilMs || 0)) {
    cfg.rlBandit.baseAlpha = Number(cfg.rlBandit.baseAlpha || 0.12) * 0.35;
  }
  return cfg;
}
