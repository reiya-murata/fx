import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyticsSummary } from "./analytics.js";

const LOG_DIR = resolve(process.cwd(), "logs");

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const REPORT_TARGET_EXIT_REASONS = new Set([
  "fast-peak-protect-exit",
  "trend-up-giveback-protect-exit",
  "no-follow-through-exit",
  "failed-entry-timing-exit",
  "quick-adverse-move-exit"
]);

function isReportTargetTrade(trade = {}) {
  const exitReason = String(trade?.exitReason || "");
  if (exitReason.startsWith("auto-")) return true;
  if (REPORT_TARGET_EXIT_REASONS.has(exitReason)) return true;
  return false;
}

function reportTargetReason(trade = {}) {
  const exitReason = String(trade?.exitReason || "");
  if (exitReason.startsWith("auto-")) return "auto_exit_reason";
  if (REPORT_TARGET_EXIT_REASONS.has(exitReason)) return "system_protective_exit_reason";
  if (!isValidTradeRecordLike(trade)) return "invalid_trade_record";
  if (!exitReason) return "missing_exit_reason";
  return "non_report_target_exit_reason";
}

function sortedAutoTrades(state) {
  return (Array.isArray(state?.trades) ? state.trades : [])
    .filter(isReportTargetTrade)
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
}

function groupedCount(list, keyFn) {
  const out = {};
  for (const row of list) {
    const k = String(keyFn(row) || "UNKNOWN");
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (!list.length) return 0;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

function tradeTimestampMs(trade = {}) {
  const ts = new Date(trade.exitTime || trade.entryTime || trade.ts || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function tradeEntryTimestampMs(trade = {}) {
  const ts = new Date(trade.entryTime || trade.exitTime || trade.ts || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function classifyPnl(value) {
  const pnl = Number(value);
  if (!Number.isFinite(pnl)) return "unknown";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "breakeven";
}

function summarizeWinLoss(list) {
  const rows = Array.isArray(list) ? list : [];
  const counts = { wins: 0, losses: 0, breakeven: 0, unknown: 0 };
  for (const row of rows) {
    const c = classifyPnl(row?.netPnlJpy);
    if (c === "win") counts.wins += 1;
    else if (c === "loss") counts.losses += 1;
    else if (c === "breakeven") counts.breakeven += 1;
    else counts.unknown += 1;
  }
  const decisive = counts.wins + counts.losses;
  return {
    totalRows: rows.length,
    ...counts,
    winRateByTotal: rows.length ? Number((counts.wins / rows.length).toFixed(4)) : 0,
    winRateExcludingBreakeven: decisive ? Number((counts.wins / decisive).toFixed(4)) : 0
  };
}

// summarizeTradeSet: summary for a trade list
function summarizeTradeSet(list, initialBalance = 1_000_000) {
  const rows = Array.isArray(list) ? list : [];
  const wl = summarizeWinLoss(rows);
  const summary = summarizeAdvanced(rows, initialBalance);
  return {
    totalTrades: rows.length,
    wins: wl.wins,
    losses: wl.losses,
    breakeven: wl.breakeven,
    unknown: wl.unknown,
    winRate: wl.winRateExcludingBreakeven,
    winRateByTotal: wl.winRateByTotal,
    grossProfitJpy: Number(rows.filter((t) => Number(t.netPnlJpy || 0) > 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
    grossLossJpy: Number(rows.filter((t) => Number(t.netPnlJpy || 0) < 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
    netProfitJpy: Number(summary.netProfitJpy || 0),
    profitFactor: summary.profitFactor,
    maxDrawdownJpy: Number(summary.maxDrawdownJpy || 0),
    expectancyR: Number(summary.expectancyR || 0)
  };
}

function isValidTradeRecordLike(trade = {}) {
  const entry = Number(trade.entryPrice || 0);
  const exit = Number(trade.exitPrice || 0);
  const qty = Number(trade.qty || 0);
  const pnl = Number(trade.netPnlJpy || 0);
  return Number.isFinite(entry) && entry > 0
    && Number.isFinite(exit) && exit > 0
    && Number.isFinite(qty) && qty > 0
    && Number.isFinite(pnl);
}

function summarizeByFn(trades, keyFn, initialBalance = 1_000_000) {
  const map = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const k = String(keyFn(t) || "UNKNOWN");
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return Object.fromEntries(
    [...map.entries()]
      .map(([k, list]) => [k, summarizeAdvanced(list, initialBalance)])
      .sort((a, b) => Number(b[1].netProfitJpy || 0) - Number(a[1].netProfitJpy || 0))
  );
}

function summarizeCrossByFn(trades, primaryKeyFn, secondaryKeyFn, initialBalance = 1_000_000) {
  const primaryMap = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const primaryKey = String(primaryKeyFn(t) || "UNKNOWN");
    const secondaryKey = String(secondaryKeyFn(t) || "UNKNOWN");
    if (!primaryMap.has(primaryKey)) primaryMap.set(primaryKey, new Map());
    const secondaryMap = primaryMap.get(primaryKey);
    if (!secondaryMap.has(secondaryKey)) secondaryMap.set(secondaryKey, []);
    secondaryMap.get(secondaryKey).push(t);
  }
  return Object.fromEntries(
    [...primaryMap.entries()].map(([primaryKey, secondaryMap]) => [
      primaryKey,
      Object.fromEntries(
        [...secondaryMap.entries()]
          .map(([secondaryKey, list]) => [secondaryKey, summarizeAdvanced(list, initialBalance)])
          .sort((a, b) => Number(b[1].netProfitJpy || 0) - Number(a[1].netProfitJpy || 0))
      )
    ])
  );
}

// summarizeExcludedTrades: summary for excluded trades
function summarizeExcludedTrades(excludedTrades, initialBalance = 1_000_000) {
  const rows = Array.isArray(excludedTrades) ? excludedTrades : [];
  return {
    ...summarizeTradeSet(rows, initialBalance),
    byExitReason: summarizeByFn(rows, (t) => t.exitReason || "UNKNOWN", initialBalance),
    byDecisionCategory: summarizeByFn(rows, (t) => t.decisionCategory || t.entryEvidenceBreakdown?.finalCategory || "UNKNOWN", initialBalance),
    byExitRule: summarizeByFn(rows, (t) => t.exitTrace?.finalExitRule || t.exitReason || "UNKNOWN", initialBalance)
  };
}

function hasNewLogicMarkers(trade = {}) {
  return trade.entryEvidenceScore !== undefined
    || trade.entryLocationScore !== undefined
    || trade.multiTimeframeScore !== undefined
    || trade.decisionTrace !== undefined
    || trade.sizingTrace !== undefined
    || trade.exitTrace !== undefined
    || trade.entryEvidenceBreakdown !== undefined
    || trade.entryLocationDiagnostics !== undefined
    || trade.multiTimeframeDiagnostics !== undefined;
}

function hasNewLogicLooseMarkers(trade = {}) {
  return firstFinite(trade.entryEvidenceScore, trade.entryEvidenceBreakdown?.totalScore) !== null
    || firstFinite(trade.entryLocationScore, trade.entryLocationDiagnostics?.entryLocationScore) !== null
    || firstFinite(trade.multiTimeframeScore, trade.multiTimeframeDiagnostics?.multiTimeframeScore) !== null;
}

function hasNewLogicStrictMarkers(trade = {}) {
  return firstFinite(trade.entryEvidenceScore, trade.entryEvidenceBreakdown?.totalScore) !== null
    && firstFinite(trade.entryLocationScore, trade.entryLocationDiagnostics?.entryLocationScore) !== null
    && firstFinite(trade.multiTimeframeScore, trade.multiTimeframeDiagnostics?.multiTimeframeScore) !== null
    && !!trade.decisionTrace;
}

function tradeIdOf(trade = {}) {
  return String(trade.id || trade.tradeId || trade.positionId || trade.positionKey || positionKeyOf(trade));
}

function scoreBandForLogic(trade, value) {
  if (!hasNewLogicMarkers(trade)) return "legacy";
  const band = scoreBand(value);
  return band === "unknown" ? "missingDiagnostics" : band;
}

function categoryForLogic(trade, value) {
  if (!hasNewLogicMarkers(trade)) return "legacy";
  return value ? String(value) : "NEW_LOGIC_MISSING_TRACE";
}

function entryLocationCategoryOf(trade = {}) {
  return categoryForLogic(
    trade,
    trade.trendUpEntryQuality?.entryTimingCategory
      || trade.entryLocationDiagnostics?.entryLocationCategory
      || trade.entryLocationCategory
  );
}

function entryLocationScoreOf(trade = {}) {
  return firstFinite(
    trade.entryLocationScore,
    trade.entryLocationDiagnostics?.entryLocationScore,
    trade.trendUpEntryQuality?.entryLocationScore
  );
}

function quickAdverseRiskScoreOf(trade = {}) {
  return firstFinite(
    trade.quickAdverseRiskScore,
    trade.quickAdverseRiskDiagnostics?.quickAdverseRiskScore,
    trade.entryLocationDiagnostics?.quickAdverseRiskScore,
    trade.trendUpEntryQuality?.quickAdverseRiskScore,
    trade.exitTrace?.quickAdverseRiskScore
  );
}

function pullbackQualityOf(trade = {}) {
  return categoryForLogic(
    trade,
    trade.pullbackQuality
      || trade.pullbackDiagnostics?.pullbackQuality
      || trade.entryLocationDiagnostics?.pullbackQuality
      || trade.trendUpEntryQuality?.pullbackQuality
  );
}

function isQuickAdverseExit(trade = {}) {
  return String(trade.exitReason || "").includes("quick-adverse")
    || trade.exitTrace?.quickAdverseMoveExit === true
    || trade.exitTrace?.earlyFailureExit === true;
}

function isAutoSlExit(trade = {}) {
  return String(trade.exitReason || "") === "auto-sl";
}

function summarizeEntryQualityIssues(trades, initialBalance = 1_000_000) {
  const list = Array.isArray(trades) ? trades : [];
  const validPullbackTrades = list.filter((t) => entryLocationCategoryOf(t) === "validPullbackEntry");
  const overextendedTrades = list.filter((t) => entryLocationCategoryOf(t) === "overextendedEntry");
  const noPullbackTrades = list.filter((t) => entryLocationCategoryOf(t) === "noPullbackEntry");
  return {
    validPullbackEntrySummary: summarizeTradeSet(validPullbackTrades, initialBalance),
    validPullbackEntryQuickAdverseCount: validPullbackTrades.filter(isQuickAdverseExit).length,
    validPullbackEntryAutoSlCount: validPullbackTrades.filter(isAutoSlExit).length,
    overextendedEntrySummary: summarizeTradeSet(overextendedTrades, initialBalance),
    overextendedEntryQuickAdverseCount: overextendedTrades.filter(isQuickAdverseExit).length,
    overextendedEntryAutoSlCount: overextendedTrades.filter(isAutoSlExit).length,
    noPullbackEntrySummary: summarizeTradeSet(noPullbackTrades, initialBalance),
    noPullbackEntryQuickAdverseCount: noPullbackTrades.filter(isQuickAdverseExit).length,
    noPullbackEntryAutoSlCount: noPullbackTrades.filter(isAutoSlExit).length
  };
}

function compactSummary(trades, initialBalance = 1_000_000) {
  const list = Array.isArray(trades) ? trades : [];
  const wl = summarizeWinLoss(list);
  const summary = summarizeAdvanced(list, initialBalance);
  return {
    totalTrades: list.length,
    wins: wl.wins,
    losses: wl.losses,
    breakeven: wl.breakeven,
    unknown: wl.unknown,
    winRate: wl.winRateExcludingBreakeven,
    netProfitJpy: Number(summary.netProfitJpy || 0),
    profitFactor: summary.profitFactor,
    expectancyR: Number(summary.expectancyR || 0)
  };
}

function summarizeLogicSplit(trades, initialBalance = 1_000_000) {
  const list = Array.isArray(trades) ? trades : [];
  const newLogicTrades = list.filter(hasNewLogicLooseMarkers);
  const newLogicStrictTrades = list.filter(hasNewLogicStrictMarkers);
  const legacyTrades = list.filter((t) => !hasNewLogicMarkers(t));
  const newLogicSlippage = slippageAdjustedSummary(newLogicTrades, initialBalance);
  const newLogicStrictSlippage = slippageAdjustedSummary(newLogicStrictTrades, initialBalance);
  const missingEntryEvidenceScoreIds = newLogicTrades
    .filter((t) => firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore) === null)
    .map(tradeIdOf);
  const missingDecisionTraceIds = newLogicTrades.filter((t) => !t.decisionTrace).map(tradeIdOf);
  const missingEntryLocationScoreIds = newLogicTrades
    .filter((t) => firstFinite(t.entryLocationScore, t.entryLocationDiagnostics?.entryLocationScore) === null)
    .map(tradeIdOf);
  const missingMultiTimeframeScoreIds = newLogicTrades
    .filter((t) => firstFinite(t.multiTimeframeScore, t.multiTimeframeDiagnostics?.multiTimeframeScore) === null)
    .map(tradeIdOf);
  const wl = summarizeWinLoss(newLogicTrades);
  const strictSummary = compactSummary(newLogicStrictTrades, initialBalance);
  return {
    newLogicDefinition: {
      requiredAnyOf: [
        "entryEvidenceScore exists",
        "entryEvidenceBreakdown exists",
        "entryLocationScore exists",
        "multiTimeframeScore exists",
        "decisionTrace exists",
        "sizingTrace exists",
        "exitTrace exists"
      ],
      looseRequiredAnyOf: [
        "entryEvidenceScore",
        "entryLocationScore",
        "multiTimeframeScore"
      ],
      strictModeRequiredFields: [
        "entryEvidenceScore",
        "entryLocationScore",
        "multiTimeframeScore",
        "decisionTrace"
      ]
    },
    newLogicSummary: {
      ...compactSummary(newLogicTrades, initialBalance),
      slippageAdjustedPF: newLogicSlippage.profitFactor,
      positionProfitFactor: summarizePositions(newLogicTrades, initialBalance).positionProfitFactor,
      avgEntryEvidenceScore: Number(average(newLogicTrades.map((t) => firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore))).toFixed(4)),
      avgEntryLocationScore: Number(average(newLogicTrades.map((t) => firstFinite(t.entryLocationScore, t.entryLocationDiagnostics?.entryLocationScore))).toFixed(4)),
      avgMultiTimeframeScore: Number(average(newLogicTrades.map((t) => firstFinite(t.multiTimeframeScore, t.multiTimeframeDiagnostics?.multiTimeframeScore))).toFixed(4))
    },
    newLogicLooseSummary: {
      ...compactSummary(newLogicTrades, initialBalance),
      slippageAdjustedPF: newLogicSlippage.profitFactor,
      positionProfitFactor: summarizePositions(newLogicTrades, initialBalance).positionProfitFactor,
      avgEntryEvidenceScore: Number(average(newLogicTrades.map((t) => firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore))).toFixed(4)),
      avgEntryLocationScore: Number(average(newLogicTrades.map((t) => firstFinite(t.entryLocationScore, t.entryLocationDiagnostics?.entryLocationScore))).toFixed(4)),
      avgMultiTimeframeScore: Number(average(newLogicTrades.map((t) => firstFinite(t.multiTimeframeScore, t.multiTimeframeDiagnostics?.multiTimeframeScore))).toFixed(4))
    },
    newLogicStrictSummary: {
      ...strictSummary,
      slippageAdjustedPF: newLogicStrictSlippage.profitFactor,
      positionProfitFactor: summarizePositions(newLogicStrictTrades, initialBalance).positionProfitFactor,
      avgEntryEvidenceScore: Number(average(newLogicStrictTrades.map((t) => firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore))).toFixed(4)),
      avgEntryLocationScore: Number(average(newLogicStrictTrades.map((t) => firstFinite(t.entryLocationScore, t.entryLocationDiagnostics?.entryLocationScore))).toFixed(4)),
      avgMultiTimeframeScore: Number(average(newLogicStrictTrades.map((t) => firstFinite(t.multiTimeframeScore, t.multiTimeframeDiagnostics?.multiTimeframeScore))).toFixed(4))
    },
    newLogicWinRateDiagnostics: {
      newLogicDefinition: {
        requiredAnyOf: [
          "entryEvidenceScore exists",
          "entryEvidenceBreakdown exists",
          "entryLocationScore exists",
          "multiTimeframeScore exists",
          "decisionTrace exists",
          "sizingTrace exists",
          "exitTrace exists"
        ],
        strictModeRequiredFields: [
          "entryEvidenceScore",
          "entryLocationScore",
          "multiTimeframeScore",
          "decisionTrace"
        ]
      },
      totalNewLogicTrades: newLogicTrades.length,
      wins: wl.wins,
      losses: wl.losses,
      breakeven: wl.breakeven,
      unknown: wl.unknown,
      winRateByTotal: wl.winRateByTotal,
      winRateExcludingBreakeven: wl.winRateExcludingBreakeven,
      netProfitJpy: Number(newLogicTrades.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
      grossProfitJpy: Number(newLogicTrades.filter((t) => Number(t.netPnlJpy || 0) > 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
      grossLossJpy: Number(newLogicTrades.filter((t) => Number(t.netPnlJpy || 0) < 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
      profitFactor: compactSummary(newLogicTrades, initialBalance).profitFactor,
      sourceTradeIds: newLogicTrades.map(tradeIdOf),
      missingDecisionTraceTradeIds: missingDecisionTraceIds,
      missingEntryEvidenceScoreTradeIds: missingEntryEvidenceScoreIds,
      missingEntryLocationScoreTradeIds: missingEntryLocationScoreIds,
      missingMultiTimeframeScoreTradeIds: missingMultiTimeframeScoreIds,
      suspiciousNewLogicTradeIds: newLogicTrades
        .filter((t) => !isValidTradeRecordLike(t) || classifyPnl(t.netPnlJpy) === "unknown")
        .map(tradeIdOf),
      verificationPassed: wl.totalRows === newLogicTrades.length
        && wl.wins === compactSummary(newLogicTrades, initialBalance).wins
        && wl.losses === compactSummary(newLogicTrades, initialBalance).losses,
      byExitReason: summarizeByFn(newLogicTrades, (t) => t.exitReason || "UNKNOWN", initialBalance),
      byEntryLocationCategory: summarizeByFn(newLogicTrades, entryLocationCategoryOf, initialBalance),
      byQuickAdverseRiskScore: summarizeByFn(newLogicTrades, (t) => scoreBandForLogic(t, quickAdverseRiskScoreOf(t)), initialBalance),
      byDecisionCategory: summarizeByFn(newLogicTrades, (t) => t.decisionCategory || t.entryEvidenceBreakdown?.finalCategory || "UNKNOWN", initialBalance),
      quickAdverseCount: newLogicTrades.filter(isQuickAdverseExit).length,
      autoSlCount: newLogicTrades.filter(isAutoSlExit).length,
      strictByExitReason: summarizeByFn(newLogicStrictTrades, (t) => t.exitReason || "UNKNOWN", initialBalance),
      strictByEntryLocationCategory: summarizeByFn(newLogicStrictTrades, entryLocationCategoryOf, initialBalance),
      strictByQuickAdverseRiskScore: summarizeByFn(newLogicStrictTrades, (t) => scoreBandForLogic(t, quickAdverseRiskScoreOf(t)), initialBalance),
      strictQuickAdverseCount: newLogicStrictTrades.filter(isQuickAdverseExit).length,
      strictAutoSlCount: newLogicStrictTrades.filter(isAutoSlExit).length
    },
    legacyLogicSummary: compactSummary(legacyTrades, initialBalance),
    missingDiagnostics: {
      newLogicTradesMissingEntryEvidenceScore: missingEntryEvidenceScoreIds.length,
      newLogicTradesMissingEntryEvidenceScoreIds: missingEntryEvidenceScoreIds,
      newLogicTradesMissingDecisionTrace: missingDecisionTraceIds.length,
      newLogicTradesMissingDecisionTraceIds: missingDecisionTraceIds,
      newLogicTradesMissingEntryLocationScore: missingEntryLocationScoreIds.length,
      newLogicTradesMissingEntryLocationScoreIds: missingEntryLocationScoreIds,
      newLogicTradesMissingMultiTimeframeScore: missingMultiTimeframeScoreIds.length,
      newLogicTradesMissingMultiTimeframeScoreIds: missingMultiTimeframeScoreIds
    }
  };
}

const SESSION_RULES_JST = {
  TOKYO: "08:00-15:59 JST",
  LONDON: "16:00-21:59 JST",
  NY: "22:00-05:59 JST",
  ROLLOVER: "06:00-07:59 JST"
};

function jstParts(ts) {
  const d = new Date(ts || 0);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const out = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    isoLike: `${out.year}-${out.month}-${out.day}T${out.hour}:${out.minute}:${out.second}+09:00`,
    minutes: Number(out.hour) * 60 + Number(out.minute)
  };
}

function detectSessionJst(ts) {
  const { minutes } = jstParts(ts);
  if (minutes >= 8 * 60 && minutes < 16 * 60) return "TOKYO";
  if (minutes >= 16 * 60 && minutes < 22 * 60) return "LONDON";
  if (minutes >= 6 * 60 && minutes < 8 * 60) return "ROLLOVER";
  return "NY";
}

function sessionDiagnosticsForTrade(trade = {}) {
  const entryMs = tradeEntryTimestampMs(trade);
  const detectedSession = detectSessionJst(entryMs);
  return {
    tradeId: trade.id || trade.positionId || null,
    entryTimeUtc: entryMs ? new Date(entryMs).toISOString() : null,
    entryTimeJst: entryMs ? jstParts(entryMs).isoLike : null,
    detectedSession,
    sessionRule: SESSION_RULES_JST[detectedSession],
    sessionSource: trade.executionSession ? "report_detected_jst_with_trade_executionSession_present" : "report_detected_jst",
    originalSession: trade.executionSession || trade.session || null,
    timezoneUsed: "JST"
  };
}

// latestTradeDiagnostics: diagnostics for latest trades
function latestTradeDiagnostics(trades, includedSet, limit = 20) {
  const rows = (Array.isArray(trades) ? trades : [])
    .slice()
    .sort((a, b) => tradeTimestampMs(b) - tradeTimestampMs(a))
    .slice(0, limit);
  return rows.map((t) => {
    const included = includedSet.has(t);
    let excludedReason = null;
    if (!included) {
      excludedReason = reportTargetReason(t);
    }
    return {
      id: tradeIdOf(t),
      entryTime: t.entryTime || null,
      exitTime: t.exitTime || null,
      side: t.side || null,
      entryPrice: t.entryPrice ?? null,
      exitPrice: t.exitPrice ?? null,
      qty: t.qty ?? null,
      netPnlJpy: Number(t.netPnlJpy || 0),
      exitReason: t.exitReason || null,
      includedInMonthlyReport: included,
      excludedReason,
      decisionCategory: t.decisionCategory || t.entryEvidenceBreakdown?.finalCategory || null,
      entryEvidenceScore: firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore),
      exitTraceFinalExitRule: t.exitTrace?.finalExitRule || null
    };
  });
}

function timeRangeJstForSession(trades, session) {
  const rows = (Array.isArray(trades) ? trades : [])
    .map(sessionDiagnosticsForTrade)
    .filter((d) => d.detectedSession === session && d.entryTimeJst)
    .map((d) => d.entryTimeJst)
    .sort();
  return rows.length ? { first: rows[0], last: rows[rows.length - 1], count: rows.length } : { first: null, last: null, count: 0 };
}

function preTradeReasonBucket(row = {}) {
  const text = `${row.detail || ""} ${row.reason || ""}`.toLowerCase();
  if (text.includes("confidence")) return "confidence";
  if (text.includes("spread")) return "spread";
  if (text.includes("edge") || text.includes("expect")) return "edge";
  if (text.includes("impact") || text.includes("news")) return "highImpact";
  if (text.includes("overextended") || text.includes("late entry") || text.includes("高値")) return "overextended";
  if (text.includes("multi") || text.includes("timeframe") || text.includes("5m") || text.includes("10m")) return "multiTimeframe";
  return "other";
}

function buildPreTradeGuardDiagnosticsSummary(skips) {
  const rows = (Array.isArray(skips) ? skips : []).filter(isPreTradeSkip);
  const reasonSummary = groupedCount(rows, (r) => r.detail || r.reason || "UNKNOWN");
  const bucketSummary = groupedCount(rows, preTradeReasonBucket);
  return {
    totalBlocked: rows.length,
    reasonSummary,
    topReasons: Object.entries(reasonSummary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    avgSignalStrength: Number(average(rows.map((r) => firstFinite(r.signalStrength, r.confidence))).toFixed(4)),
    avgEdgeAfterBuffer: Number(average(rows.map((r) => firstFinite(r.edgeAfterBuffer, r.preTradeGuard?.edgeAfterBuffer))).toFixed(4)),
    avgSpreadPips: Number(average(rows.map((r) => firstFinite(r.spreadPips, r.preTradeGuard?.spreadPips))).toFixed(4)),
    avgSpreadGatePips: Number(average(rows.map((r) => firstFinite(r.spreadGatePips, r.preTradeGuard?.spreadGatePips))).toFixed(4)),
    avgExecutionStress: Number(average(rows.map((r) => firstFinite(r.executionStress, r.preTradeGuard?.executionStress))).toFixed(4)),
    blockedByConfidence: bucketSummary.confidence || 0,
    blockedBySpread: bucketSummary.spread || 0,
    blockedByEdge: bucketSummary.edge || 0,
    blockedByHighImpact: bucketSummary.highImpact || 0,
    blockedByOverextended: bucketSummary.overextended || 0,
    blockedByMultiTimeframe: bucketSummary.multiTimeframe || 0,
    blockedByOther: bucketSummary.other || 0
  };
}

function isNoActionableSkip(row = {}) {
  return String(row?.reason || "").toLowerCase().includes("no actionable signal");
}

function buildNoActionableSignalDiagnosticsSummary(skips) {
  const rows = (Array.isArray(skips) ? skips : []).filter(isNoActionableSkip);
  const categorySummary = groupedCount(rows, (r) => r.noActionableSignalDiagnostics?.category || "UNKNOWN");
  return {
    totalNoActionable: rows.length,
    categorySummary,
    noEdgeCount: categorySummary.NO_EDGE || 0,
    rangeTooWideCount: categorySummary.RANGE_TOO_WIDE || 0,
    weakSignalCount: categorySummary.WEAK_SIGNAL || 0,
    multiTimeframeMismatchCount: categorySummary.MULTI_TIMEFRAME_MISMATCH || 0,
    shortTermExhaustionCount: categorySummary.SHORT_TERM_EXHAUSTION || 0,
    probeCandidateCount: categorySummary.PROBE_CANDIDATE || 0,
    unknownCount: categorySummary.UNKNOWN || 0
  };
}

function riskDiagOf(trade = {}) {
  const diag = trade.positionSizingDiagnostics || trade.sizingDiagnostics || trade.parameterSnapshot?.positionSizingDiagnostics || {};
  const settings = trade.parameterSnapshot?.settings || {};
  const qty = firstFinite(trade.qty, trade.calculatedUnits, diag.calculatedUnits);
  const price = firstFinite(trade.entryPrice, trade.exitPrice, diag.currentUsdJpyPrice);
  const balanceJPY = firstFinite(diag.balanceJPY, settings.balanceJPY, settings.paperCapitalJpy, settings.liveCapitalJpy);
  const stopLossPips = firstFinite(diag.stopLossPips, trade.stopLossPips, settings.stopLossPips);
  const exposure = firstFinite(diag.estimatedExposureJPY, qty !== null && price !== null ? qty * price : null);
  return {
    ...diag,
    balanceJPY,
    riskAmountJPY: firstFinite(diag.riskAmountJPY, settings.riskAmountJPY, balanceJPY !== null ? balanceJPY * Number(settings.riskPercentPerTrade ?? 0) / 100 : null),
    effectiveLeverage: firstFinite(diag.effectiveLeverage, exposure !== null && balanceJPY ? exposure / balanceJPY : null),
    calculatedUnits: firstFinite(diag.calculatedUnits, qty),
    estimatedLossJPY: firstFinite(diag.estimatedLossJPY, stopLossPips !== null && qty !== null ? stopLossPips * qty * 0.01 : null),
    requiredMarginJPY: firstFinite(diag.requiredMarginJPY, exposure !== null ? exposure / Number(settings.legalMaxLeverage || 25) : null),
    finalSizeMultiplier: firstFinite(diag.finalSizeMultiplier, trade.finalSizeMultiplier, trade.sizingTrace?.finalSizeMultiplier)
  };
}

function signalStrengthOf(trade = {}) {
  return firstFinite(
    trade.signalConfidence,
    trade.signalMetrics?.signalStrength,
    trade.preTradeGuard?.signalStrength,
    trade.signalStrength,
    trade.confidence
  );
}

function scoreBand(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  const v = Number(value);
  if (!Number.isFinite(v)) return "unknown";
  if (v < 0.45) return "blocked(<0.45)";
  if (v < 0.60) return "weak(0.45-0.60)";
  if (v < 0.75) return "probe(0.60-0.75)";
  return "strong(>=0.75)";
}
function sizeMultiplierBand(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  const v = Number(value);
  if (!Number.isFinite(v)) return "unknown";
  if (v <= 0) return "blocked_or_zero(<=0)";
  if (v < 0.20) return "micro(<0.20)";
  if (v < 0.45) return "low(0.20-0.45)";
  if (v < 0.60) return "reduced(0.45-0.60)";
  if (v < 0.90) return "normal_low(0.60-0.90)";
  if (v < 1.10) return "normal(0.90-1.10)";
  return "expanded(>=1.10)";
}

function finalSizeMultiplierOf(trade = {}) {
  return firstFinite(
    trade.finalSizeMultiplier,
    trade.sizingTrace?.finalSizeMultiplier,
    trade.positionSizingDiagnostics?.finalSizeMultiplier,
    trade.sizingMultiplier
  );
}

function boolBand(value, trueLabel, falseLabel) {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return "unknown";
}

function gateFromSkipReason(reasonText) {
  const reason = String(reasonText || "").toLowerCase();
  if (reason.includes("execution tail")) return "tailPenalty";
  if (reason.includes("no-trade zone")) return "noTradeZone";
  if (reason.includes("pre-trade")) return "preTrade";
  if (reason.includes("rolling")) return "rolling";
  if (reason.includes("kill")) return "killSwitch";
  if (reason.includes("anomaly")) return "anomaly";
  if (reason.includes("ensemble")) return "ensemble";
  return "other";
}

function isPreTradeSkip(row = {}) {
  const reason = String(row?.reason || "").toLowerCase();
  const detail = String(row?.detail || "").toLowerCase();
  return reason.includes("pre-trade") || detail.includes("pre-trade");
}

function isReentrySkip(row = {}) {
  const reason = String(row?.reason || "").toLowerCase();
  const reasonCode = String(row?.reasonCode || "").toUpperCase();
  return reasonCode.startsWith("REENTRY_") || reason.includes("再エントリー");
}

function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const idx = clamp(Math.floor((list.length - 1) * p), 0, list.length - 1);
  return list[idx];
}

function ymd(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function ym(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function expectancyInR(trades) {
  if (!trades.length) return 0;
  const wins = trades.filter((t) => Number(t.netPnlJpy || 0) > 0).map((t) => Number(t.netPnlJpy || 0));
  const losses = trades.filter((t) => Number(t.netPnlJpy || 0) < 0).map((t) => Math.abs(Number(t.netPnlJpy || 0)));
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 1;
  if (!(avgLoss > 0)) return 0;
  const p = wins.length / trades.length;
  const avgWinR = wins.length ? (wins.reduce((s, v) => s + v, 0) / wins.length) / avgLoss : 0;
  return p * avgWinR - (1 - p);
}

function std(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, v));
}

function summarizeAdvanced(trades, initialBalance = 1_000_000) {
  const base = analyticsSummary(trades || []);
  const list = Array.isArray(trades) ? trades : [];
  const returns = list.map((t) => Number(t.netPnlJpy || 0) / Math.max(1, Number(initialBalance || 1_000_000)));
  const mean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const sigma = std(returns);
  const downside = returns.filter((x) => x < 0);
  const downSigma = std(downside);
  return {
    ...base,
    expectancyR: Number(expectancyInR(list).toFixed(6)),
    sharpe: Number((sigma > 0 ? mean / sigma : 0).toFixed(4)),
    sortino: Number((downSigma > 0 ? mean / downSigma : 0).toFixed(4))
  };
}

function summarizeBy(trades, key, initialBalance = 1_000_000) {
  const map = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const k = String(t?.[key] || "UNKNOWN");
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return Object.fromEntries(
    [...map.entries()]
      .map(([k, list]) => [k, summarizeAdvanced(list, initialBalance)])
      .sort((a, b) => Number(b[1].netProfitJpy || 0) - Number(a[1].netProfitJpy || 0))
  );
}

function capitalTierOf(trade, fallbackTier = "UNKNOWN") {
  const direct = trade?.positionSizingDiagnostics?.capitalScalingDiagnostics?.activeTierId
    || trade?.capitalScalingDiagnostics?.activeTierId;
  if (direct) return String(direct);
  const profile = trade?.parameterSnapshot?.settings?.selectedRiskProfile
    || trade?.positionSizingDiagnostics?.selectedRiskProfile;
  const profileText = String(profile || "");
  if (/^(UNDER_|TIER_)/i.test(profileText)) return profileText;
  return String(fallbackTier || profileText || "UNKNOWN");
}

function summarizeSizingFields(list) {
  return {
    averageRiskAmountJPY: Number(average(list.map((t) => firstFinite(riskDiagOf(t).riskAmountJPY, t.riskAmountJPY))).toFixed(2)),
    averageEffectiveLeverage: Number(average(list.map((t) => firstFinite(riskDiagOf(t).effectiveLeverage, t.effectiveLeverage))).toFixed(4)),
    averageCalculatedUnits: Number(average(list.map((t) => firstFinite(riskDiagOf(t).calculatedUnits, t.qty))).toFixed(2)),
    averageEstimatedLossJPY: Number(average(list.map((t) => firstFinite(riskDiagOf(t).estimatedLossJPY, t.estimatedLossJPY))).toFixed(2)),
    averageRequiredMarginJPY: Number(average(list.map((t) => firstFinite(riskDiagOf(t).requiredMarginJPY, t.requiredMarginJPY))).toFixed(2)),
    averageFinalSizeMultiplier: Number(average(list.map((t) => firstFinite(t.finalSizeMultiplier, t.sizingTrace?.finalSizeMultiplier, t.sizingMultiplier, 1))).toFixed(4))
  };
}

function summarizeByCapitalTier(trades, initialBalance = 1_000_000, fallbackTier = "UNKNOWN") {
  const map = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const k = capitalTierOf(t, fallbackTier);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return Object.fromEntries([...map.entries()].map(([k, list]) => {
    return [k, {
      ...summarizeAdvanced(list, initialBalance),
      ...summarizeSizingFields(list)
    }];
  }));
}

function signalStrengthBand(t) {
  const v = signalStrengthOf(t);
  if (v === null) return "unknown";
  if (v < 0.55) return "low(<0.55)";
  if (v < 0.70) return "mid(0.55-0.70)";
  if (v < 0.80) return "high(0.70-0.80)";
  return "veryHigh(>=0.80)";
}

function summarizeBySignalStrength(trades, initialBalance = 1_000_000) {
  const map = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const k = signalStrengthBand(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return Object.fromEntries([...map.entries()].map(([k, list]) => [k, summarizeAdvanced(list, initialBalance)]));
}

function slippageAdjustedSummary(trades, initialBalance = 1_000_000) {
  const adjusted = applyStress(trades, { spreadMul: 1, slippageMul: 1.5, rejectMul: 1 });
  return summarizeAdvanced(adjusted, initialBalance);
}

function positionKeyOf(trade = {}) {
  return String(
    trade.positionId
    || trade.positionKey
    || `${trade.signalId || "no-signal"}:${trade.entryTime || "no-entry"}:${trade.side || "no-side"}:${trade.entryPrice || "no-price"}`
  );
}

function toPositionTrades(trades) {
  const map = new Map();
  for (const t of (Array.isArray(trades) ? trades : [])) {
    const key = positionKeyOf(t);
    const row = map.get(key) || {
      ...t,
      id: key,
      positionKey: key,
      qty: 0,
      netPnlJpy: 0,
      feeJpy: 0,
      exitPnlPips: 0,
      mfeR: 0,
      maeR: 0,
      mfePips: 0,
      maePips: 0,
      partialRows: 0
    };
    const qty = Number(t.qty || 0);
    const pnl = Number(t.netPnlJpy || 0);
    row.qty = Math.max(Number(row.qty || 0), qty);
    row.netPnlJpy = Number((Number(row.netPnlJpy || 0) + pnl).toFixed(2));
    row.feeJpy = Number((Number(row.feeJpy || 0) + Number(t.feeJpy || 0)).toFixed(2));
    row.exitTime = new Date(t.exitTime || row.exitTime || t.entryTime || 0) >= new Date(row.exitTime || 0) ? t.exitTime : row.exitTime;
    row.holdingSeconds = Math.max(Number(row.holdingSeconds || 0), Number(t.holdingSeconds || 0));
    row.exitPnlPips = Number((Number(row.exitPnlPips || 0) + Number(t.exitPnlPips || 0)).toFixed(4));
    row.mfeR = Math.max(Number(row.mfeR || 0), Number(t.mfeR || 0));
    row.maeR = Math.max(Number(row.maeR || 0), Number(t.maeR || 0));
    row.mfePips = Math.max(Number(row.mfePips || 0), Number(t.peakPnlPips || t.mfePips || 0));
    row.maePips = Math.max(Number(row.maePips || 0), Math.abs(Number(t.worstPnlPips || t.maePips || 0)));
    row.partialRows = Number(row.partialRows || 0) + 1;
    map.set(key, row);
  }
  return [...map.values()];
}

function summarizePositions(trades, initialBalance = 1_000_000) {
  const positions = toPositionTrades(trades);
  const summary = summarizeAdvanced(positions, initialBalance);
  const wins = positions.filter((t) => Number(t.netPnlJpy || 0) > 0);
  const losses = positions.filter((t) => Number(t.netPnlJpy || 0) < 0);
  const avgWin = average(wins.map((t) => Number(t.netPnlJpy || 0)));
  const avgLoss = average(losses.map((t) => Math.abs(Number(t.netPnlJpy || 0))));
  return {
    ...summary,
    positionCount: positions.length,
    positionWins: wins.length,
    positionLosses: losses.length,
    positionWinRate: positions.length ? Number((wins.length / positions.length).toFixed(4)) : 0,
    positionGrossProfitJpy: Number(wins.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
    positionGrossLossJpy: Number(losses.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
    positionNetProfitJpy: Number(positions.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0).toFixed(2)),
    positionProfitFactor: summary.profitFactor,
    positionMaxDrawdownJpy: summary.maxDrawdownJpy,
    averagePositionHoldingSeconds: Number(average(positions.map((t) => t.holdingSeconds)).toFixed(2)),
    averagePositionMfeR: Number(average(positions.map((t) => t.mfeR)).toFixed(4)),
    averagePositionMaeR: Number(average(positions.map((t) => t.maeR)).toFixed(4)),
    averagePositionMfePips: Number(average(positions.map((t) => t.mfePips)).toFixed(4)),
    averagePositionMaePips: Number(average(positions.map((t) => t.maePips)).toFixed(4)),
    positionAverageWinJpy: Number(avgWin.toFixed(2)),
    positionAverageLossJpy: Number(avgLoss.toFixed(2)),
    positionAvgLossToAvgWinRatio: Number((avgWin > 0 ? avgLoss / avgWin : 0).toFixed(4))
  };
}

function summarizeModeKpi(trades, initialBalance = 1_000_000) {
  const list = Array.isArray(trades) ? trades : [];
  const sum = summarizeAdvanced(list, initialBalance);
  const mfe = list.map((t) => Number(t.mfeR || 0)).filter((x) => Number.isFinite(x) && x > 0);
  const finalSize = list.map((t) => Number(t.finalSizeMultiplier || t.sizingMultiplier || 1)).filter(Number.isFinite);
  const capture = list
    .map((t) => {
      const peak = Number(t.peakPnlPips || 0);
      const realized = Number(t.exitPnlPips || 0);
      if (!(peak > 0)) return null;
      return clamp(realized / peak, -1, 2);
    })
    .filter((x) => x !== null);
  return {
    ...sum,
    mfeR: {
      p50: Number(percentile(mfe, 0.5).toFixed(4)),
      p80: Number(percentile(mfe, 0.8).toFixed(4)),
      p90: Number(percentile(mfe, 0.9).toFixed(4))
    },
    takeRate: {
      sampleSize: capture.length,
      avg: capture.length ? Number((capture.reduce((s, v) => s + v, 0) / capture.length).toFixed(4)) : 0,
      p50: Number(percentile(capture, 0.5).toFixed(4)),
      p90: Number(percentile(capture, 0.9).toFixed(4))
    },
    finalSizeMultiplier: {
      sampleSize: finalSize.length,
      p10: Number(percentile(finalSize, 0.1).toFixed(4)),
      p50: Number(percentile(finalSize, 0.5).toFixed(4)),
      p90: Number(percentile(finalSize, 0.9).toFixed(4))
    }
  };
}

function applyStress(trades, { spreadMul = 1, slippageMul = 1, rejectMul = 1 } = {}) {
  const PIP_SIZE = 0.01;
  return (Array.isArray(trades) ? trades : []).map((t) => {
    const qty = Math.max(0, Number(t.qty || 0));
    const spread = Math.max(0, Number(t.signalMetrics?.spreadPips || 0.18)) * (spreadMul - 1);
    const slip = Math.max(0, Number(t.slippagePips || 0.05)) * (slippageMul - 1);
    const rejectPenalty = clamp((rejectMul - 1) * 0.05, 0, 0.4);
    const extraCost = qty * PIP_SIZE * (spread + slip);
    const net = Number(t.netPnlJpy || 0);
    return { ...t, netPnlJpy: Number((net * (1 - rejectPenalty) - extraCost).toFixed(2)) };
  });
}

function splitOos(trades, ratio = 0.3) {
  const list = Array.isArray(trades) ? trades : [];
  const cut = Math.max(1, Math.floor(list.length * (1 - ratio)));
  return {
    inSample: list.slice(0, cut),
    oos: list.slice(cut)
  };
}

function writeJson(name, payload) {
  ensureLogDir();
  const path = resolve(LOG_DIR, name);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function buildWeeklyFrequencyReport(state, now = new Date()) {
  const toMs = now.getTime();
  const fromMs = toMs - 7 * 24 * 60 * 60 * 1000;
  const logs = (Array.isArray(state?.auditLogs) ? state.auditLogs : [])
    .filter((a) => {
      const t = new Date(a.ts || 0).getTime();
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    });
  const hardBlocks = logs.filter((a) => a.event === "auto.skip" && String(a.reason || "").includes("execution tail gate"));
  const rescue = logs.filter((a) => a.event === "auto.rolling.rescue");
  const cooldownEntries = logs.filter((a) => a.event === "auto.cooldown.enter");
  const cooldownTotalSec = cooldownEntries.reduce((s, a) => s + Number(a.cooldownSec || 0), 0)
    + rescue.reduce((s, a) => s + Number(a.cooldownSec || 0), 0);
  const openedLogs = logs.filter((a) => a.event === "auto.position.opened");
  const penalties = openedLogs
    .filter((a) => a.event === "auto.position.opened")
    .map((a) => Number(a.tailPenaltyMultiplier || a.tailAwareSizeMultiplier || 1))
    .filter(Number.isFinite);
  const finalSizeMultipliers = openedLogs
    .map((a) => Number(a.finalSizeMultiplier || a.sizingMultiplier || 1))
    .filter(Number.isFinite);
  const openedByMode = {
    BASE: openedLogs.filter((a) => String(a.tradeMode || "BASE").toUpperCase() === "BASE"),
    SEMI: openedLogs.filter((a) => String(a.tradeMode || "BASE").toUpperCase() === "SEMI"),
    FULL: openedLogs.filter((a) => {
      const m = String(a.tradeMode || "BASE").toUpperCase();
      return m === "FULL" || m === "AGGRESSIVE";
    })
  };
  const holdReasons = groupedCount(logs.filter((a) => a.event === "auto.skip"), (a) => a.reason || "UNKNOWN");
  const scalingEvents = logs.filter((a) => String(a.event || "").startsWith("capitalScaling."));
  const skips = logs.filter((a) => a.event === "auto.skip");
  const tradeExecutedCount = openedLogs.length;
  const tradeOpportunityCount = tradeExecutedCount + skips.length;
  const passRateByGateCounts = {};
  for (const row of skips) {
    const gate = gateFromSkipReason(row.reason || row.detail || "");
    passRateByGateCounts[gate] = (passRateByGateCounts[gate] || 0) + 1;
  }
  const passRateByGate = Object.fromEntries(
    Object.entries(passRateByGateCounts).map(([gate, holdCount]) => [gate, {
      holdCount,
      passRate: tradeOpportunityCount > 0
        ? Number((1 - holdCount / tradeOpportunityCount).toFixed(4))
        : 0
    }])
  );
  const weeklyTrades = sortedAutoTrades(state).filter((t) => {
    const tMs = new Date(t.exitTime || t.entryTime || 0).getTime();
    return Number.isFinite(tMs) && tMs >= fromMs && tMs <= toMs;
  });
  const timeInMarketSec = weeklyTrades.reduce((sum, t) => {
    const entryMs = new Date(t.entryTime || 0).getTime();
    const exitMs = new Date(t.exitTime || t.entryTime || 0).getTime();
    if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs) || exitMs <= entryMs) return sum;
    return sum + Math.max(0, Math.round((exitMs - entryMs) / 1000));
  }, 0);
  const lowSizeCount = finalSizeMultipliers.filter((x) => x < 0.4).length;
  const lowSizeShare = finalSizeMultipliers.length > 0 ? (lowSizeCount / finalSizeMultipliers.length) : 0;
  const gateRelaxationCandidates = lowSizeShare >= 0.2
    ? Object.entries(holdReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }))
    : [];
  const weeklySummary = summarizeAdvanced(weeklyTrades, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const slippageAdjusted = slippageAdjustedSummary(weeklyTrades, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const weeklyPositionSummary = summarizePositions(weeklyTrades, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const weeklySlippageAdjustedPosition = summarizePositions(
    applyStress(weeklyTrades, { spreadMul: 1, slippageMul: 1.5, rejectMul: 1 }),
    Number(state?.account?.initialBalanceJpy || 1_000_000)
  );
  const ddPct = Number(state?.account?.initialBalanceJpy || 1_000_000) > 0
    ? (Number(weeklySummary.maxDrawdownJpy || 0) / Number(state?.account?.initialBalanceJpy || 1_000_000)) * 100
    : 0;
  const weeklyChecksGo = {
    tradeCount: weeklyTrades.length >= 30,
    profitFactor: Number(weeklySummary.profitFactor || 0) >= 1.15,
    netExpectancyPips: Number(weeklySummary.expectancyR || 0) >= 0.03,
    maxDrawdownPct: ddPct <= 3,
    slippageAdjustedPF: Number(slippageAdjusted.profitFactor || 0) >= 1.05
  };
  const weeklyChecksNoGo = {
    profitFactor: Number(weeklySummary.profitFactor || 0) < 1.0,
    netExpectancyPips: Number(weeklySummary.expectancyR || 0) < 0,
    maxDrawdownPct: ddPct > 5,
    slippageAdjustedPF: Number(slippageAdjusted.profitFactor || 0) < 0.95
  };
  const weeklyGoNoGo = Object.values(weeklyChecksGo).every(Boolean)
    ? "GO"
    : (Object.values(weeklyChecksNoGo).some(Boolean) ? "NO-GO" : "WATCH");
  const modeKpi = Object.fromEntries(Object.entries(openedByMode).map(([mode, list]) => {
    const trades = weeklyTrades.filter((t) => {
      const m = String(t.tradeMode || "BASE").toUpperCase();
      if (mode === "FULL") return m === "FULL" || m === "AGGRESSIVE";
      return m === mode;
    });
    const mfe = trades.map((t) => Number(t.mfeR || 0)).filter((x) => Number.isFinite(x) && x > 0);
    const mae = trades.map((t) => Number(t.maeR || 0)).filter((x) => Number.isFinite(x) && x >= 0);
    const capture = trades
      .map((t) => {
        const peak = Number(t.peakPnlPips || 0);
        const realized = Number(t.exitPnlPips || 0);
        if (!(peak > 0)) return null;
        return clamp(realized / peak, -1, 2);
      })
      .filter((x) => x !== null);
    const size = list.map((x) => Number(x.finalSizeMultiplier || x.sizingMultiplier || 1)).filter(Number.isFinite);
    const holdByMode = {};
    for (const row of openedLogs) {
      const elig = row.modeEligibility || {};
      const target = mode === "FULL" ? (elig.full || {}) : (mode === "SEMI" ? (elig.semi || {}) : null);
      if (!target || !Array.isArray(target.reasons)) continue;
      for (const reason of target.reasons) {
        holdByMode[reason] = (holdByMode[reason] || 0) + 1;
      }
    }
    return [mode, {
      trades: trades.length,
      summary: summarizeAdvanced(trades, Number(state?.account?.initialBalanceJpy || 1_000_000)),
      mfeR: {
        p50: Number(percentile(mfe, 0.5).toFixed(4)),
        p80: Number(percentile(mfe, 0.8).toFixed(4)),
        p90: Number(percentile(mfe, 0.9).toFixed(4))
      },
      maeR: {
        p50: Number(percentile(mae, 0.5).toFixed(4)),
        p80: Number(percentile(mae, 0.8).toFixed(4)),
        p90: Number(percentile(mae, 0.9).toFixed(4))
      },
      takeRate: {
        sampleSize: capture.length,
        p50: Number(percentile(capture, 0.5).toFixed(4)),
        p80: Number(percentile(capture, 0.8).toFixed(4))
      },
      finalSizeMultiplier: {
        p10: Number(percentile(size, 0.1).toFixed(4)),
        p50: Number(percentile(size, 0.5).toFixed(4)),
        p90: Number(percentile(size, 0.9).toFixed(4))
      },
      holdReasonRank: Object.entries(holdByMode)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count }))
    }];
  }));
  const semiFullShare = tradeExecutedCount > 0
    ? (openedByMode.SEMI.length + openedByMode.FULL.length) / tradeExecutedCount
    : 0;
  const fullShare = tradeExecutedCount > 0
    ? openedByMode.FULL.length / tradeExecutedCount
    : 0;
  const eligibilityReasons = {};
  for (const row of openedLogs) {
    const elig = row.modeEligibility || row.aggressiveEligibility || {};
    const fullReasons = Array.isArray(elig?.full?.reasons) ? elig.full.reasons : [];
    const semiReasons = Array.isArray(elig?.semi?.reasons) ? elig.semi.reasons : [];
    for (const r of [...fullReasons, ...semiReasons]) {
      eligibilityReasons[r] = (eligibilityReasons[r] || 0) + 1;
    }
  }
  const shareTargets = {
    semiFullMin: 0.25,
    semiFullMax: 0.35,
    fullMin: 0.10,
    fullMax: 0.18
  };
  const shareOutsideTarget = semiFullShare < shareTargets.semiFullMin
    || semiFullShare > shareTargets.semiFullMax
    || fullShare < shareTargets.fullMin
    || fullShare > shareTargets.fullMax;
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowDays: 7,
    hardBlockCount: hardBlocks.length,
    hardBlockByMode: groupedCount(hardBlocks, (a) => a.mode || "UNKNOWN"),
    rescueCount: rescue.length,
    cooldownTotalSec,
    cooldownTotalMinutes: Number((cooldownTotalSec / 60).toFixed(2)),
    timeInMarketSec,
    tradeOpportunityCount,
    tradeExecutedCount,
    passRateByGate,
    penalty: {
      sampleSize: penalties.length,
      avg: penalties.length ? Number((penalties.reduce((s, v) => s + v, 0) / penalties.length).toFixed(4)) : 0,
      p50: Number(percentile(penalties, 0.5).toFixed(4)),
      p90: Number(percentile(penalties, 0.9).toFixed(4))
    },
    finalSizeMultiplier: {
      sampleSize: finalSizeMultipliers.length,
      p10: Number(percentile(finalSizeMultipliers, 0.1).toFixed(4)),
      p50: Number(percentile(finalSizeMultipliers, 0.5).toFixed(4)),
      p90: Number(percentile(finalSizeMultipliers, 0.9).toFixed(4))
    },
    modeKpi,
    weeklySummary,
    tradeRowSummary: weeklySummary,
    positionSummary: weeklyPositionSummary,
    tradeRowProfitFactor: weeklySummary.profitFactor,
    positionProfitFactor: weeklyPositionSummary.positionProfitFactor,
    slippageAdjustedTradeRowPF: slippageAdjusted.profitFactor,
    slippageAdjustedPositionPF: weeklySlippageAdjustedPosition.positionProfitFactor,
    slippageAdjusted: {
      profitFactor: slippageAdjusted.profitFactor === null ? null : Number(slippageAdjusted.profitFactor.toFixed(4)),
      expectancyR: Number(slippageAdjusted.expectancyR || 0),
      netExpectancyPips: Number(slippageAdjusted.expectancyR || 0),
      netProfitJpy: Number(slippageAdjusted.netProfitJpy || 0)
    },
    bySession: summarizeBy(weeklyTrades, "executionSession", Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byRegime: summarizeBy(weeklyTrades, "regime", Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byMode: summarizeBy(weeklyTrades, "tradeMode", Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byCapitalTier: summarizeByCapitalTier(
      weeklyTrades,
      Number(state?.account?.initialBalanceJpy || 1_000_000),
      state?.capitalScalingRuntime?.activeTierId || "UNKNOWN"
    ),
    bySignalStrength: summarizeBySignalStrength(weeklyTrades, Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byDecisionCategory: summarizeBy(weeklyTrades, "decisionCategory", Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byEntryEvidenceScore: Object.fromEntries(Object.entries(groupedCount(weeklyTrades, (t) => scoreBand(t.entryEvidenceScore))).map(([k, count]) => [k, { count }])),
    byMultiTimeframeScore: Object.fromEntries(Object.entries(groupedCount(weeklyTrades, (t) => scoreBand(t.multiTimeframeScore))).map(([k, count]) => [k, { count }])),
    byShortTermAlignment: Object.fromEntries(Object.entries(groupedCount(weeklyTrades, (t) => scoreBand(t.shortTermAlignmentScore))).map(([k, count]) => [k, { count }])),
    byShortTermExhaustion: Object.fromEntries(Object.entries(groupedCount(weeklyTrades, (t) => scoreBand(1 - Number(t.shortTermExhaustionScore || 0)))).map(([k, count]) => [k, { count }])),
    byTrendUpEntryQuality: groupedCount(weeklyTrades, (t) => t.trendUpEntryQuality?.entryTimingCategory || t.entryLocationDiagnostics?.entryLocationCategory || "UNKNOWN"),
    byEntryLocationScore: Object.fromEntries(Object.entries(groupedCount(weeklyTrades, (t) => scoreBand(t.entryLocationScore))).map(([k, count]) => [k, { count }])),
    byEntryLocationCategory: groupedCount(weeklyTrades, (t) => t.entryLocationDiagnostics?.entryLocationCategory || "UNKNOWN"),
    byExitRule: summarizeBy(weeklyTrades, "exitReason", Number(state?.account?.initialBalanceJpy || 1_000_000)),
    byBlockedStage: groupedCount(logs.filter((a) => a.event === "auto.skip"), (a) => a.blockedStage || a.reason || "UNKNOWN"),
    byNoActionableSignalCategory: groupedCount(logs.filter((a) => a.event === "auto.skip"), (a) => a.noActionableSignalDiagnostics?.category || "UNKNOWN"),
    blockRates: {
      preTradeGuard: Number((skips.length > 0 ? (skips.filter(isPreTradeSkip).length / skips.length) : 0).toFixed(4)),
      reentryGuard: Number((skips.length > 0 ? (skips.filter(isReentrySkip).length / skips.length) : 0).toFixed(4))
    },
    weeklyGoNoGo: {
      decision: weeklyGoNoGo,
      checksGo: weeklyChecksGo,
      checksNoGo: weeklyChecksNoGo
    },
    modeShare: {
      baseShare: Number((tradeExecutedCount > 0 ? openedByMode.BASE.length / tradeExecutedCount : 0).toFixed(4)),
      semiShare: Number((tradeExecutedCount > 0 ? openedByMode.SEMI.length / tradeExecutedCount : 0).toFixed(4)),
      fullShare: Number(fullShare.toFixed(4)),
      semiFullShare: Number(semiFullShare.toFixed(4)),
      target: shareTargets
    },
    capitalScaling: {
      activeTierId: state?.capitalScalingRuntime?.activeTierId || "UNKNOWN",
      candidateTierId: state?.capitalScalingRuntime?.candidateTierId || "UNKNOWN",
      promotionCount: scalingEvents.filter((a) => String(a.event || "").includes("tier_promoted")).length,
      demotionCount: scalingEvents.filter((a) => String(a.event || "").includes("tier_demoted")).length,
      eventSummary: groupedCount(scalingEvents, (a) => a.event)
    },
    eligibilityBlockers: Object.entries(eligibilityReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([reason, count]) => ({ reason, count })),
    shareOutsideTarget,
    gateRelaxationCandidates,
    holdReasonRank: Object.entries(holdReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }))
      .slice(0, 15)
  };
  const file = writeJson(`weekly_report_${ymd(now.toISOString())}.json`, payload);
  return { ...payload, file };
}

export function buildMonthlyPerformanceReport(state, now = new Date()) {
  const allAuto = sortedAutoTrades(state);
  const includedMonthlySet = new Set(allAuto);
  const init = Number(state?.account?.initialBalanceJpy || 1_000_000);
  const allTradeRows = Array.isArray(state?.trades) ? state.trades : [];
  const validTradeRows = allTradeRows.filter(isValidTradeRecordLike);
  const excludedTradeRows = allTradeRows.filter((t) => !includedMonthlySet.has(t));
  const activeMode = String(state?.settings?.autoExecutionMode || "PAPER_LIVE").toUpperCase();
  const apiModeTrades = validTradeRows.filter((t) => String(t?.executionMode || "PAPER_LIVE").toUpperCase() === activeMode);
  const allSkips = (Array.isArray(state?.auditLogs) ? state.auditLogs : [])
    .filter((a) => a.event === "auto.skip");
  const allLogs = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
  const split = splitOos(allAuto, 0.3);
  const base = summarizeAdvanced(allAuto, init);
  const positionSummary = summarizePositions(allAuto, init);
  const positions = toPositionTrades(allAuto);
  const winLossRows = summarizeWinLoss(allAuto);
  const winLossPositions = summarizeWinLoss(positions);
  const logicSplit = summarizeLogicSplit(allAuto, init);
  const sessionDiagnostics = allAuto.map(sessionDiagnosticsForTrade);
  const entryTimes = allAuto.map(tradeEntryTimestampMs).filter(Boolean);
  const eventTimes = allAuto.map(tradeTimestampMs).filter(Boolean);
  const loadedEventTimes = allTradeRows.map(tradeTimestampMs).filter(Boolean);
  const excludedEventTimes = excludedTradeRows.map(tradeTimestampMs).filter(Boolean);
  const reportStartMs = entryTimes.length ? Math.min(...entryTimes) : null;
  const reportEndMs = eventTimes.length ? Math.max(...eventTimes) : null;
  const sourceDiagnostics = {
    sourceFiles: [resolve(process.cwd(), "data/state.json")],
    loadedTradeRows: allTradeRows.length,
    filteredTradeRows: allAuto.length,
    excludedRows: Math.max(0, allTradeRows.length - allAuto.length),
    reportTargetRule: {
      includedExitReasons: ["auto-*", ...REPORT_TARGET_EXIT_REASONS],
      note: "monthly report includes auto-* exits and system protective exits generated by the new exit logic"
    },
    includedReasonSummary: groupedCount(allAuto, reportTargetReason),
    excludedReasonSummary: groupedCount(allTradeRows.filter((t) => !includedMonthlySet.has(t)), reportTargetReason),
    latestTradeEntryTime: entryTimes.length ? new Date(Math.max(...entryTimes)).toISOString() : null,
    latestLoadedTradeExitTime: loadedEventTimes.length ? new Date(Math.max(...loadedEventTimes)).toISOString() : null,
    latestTradeExitTime: eventTimes.length ? new Date(Math.max(...eventTimes)).toISOString() : null,
    latestExcludedTradeExitTime: excludedEventTimes.length ? new Date(Math.max(...excludedEventTimes)).toISOString() : null,
    reportGeneratedAt: now.toISOString(),
    reportTimeRangeStart: reportStartMs ? new Date(reportStartMs).toISOString() : null,
    reportTimeRangeEnd: reportEndMs ? new Date(reportEndMs).toISOString() : null
  };
  const apiWl = summarizeWinLoss(apiModeTrades);
  const reportWinRate = winLossRows.winRateExcludingBreakeven;
  const apiWinRate = apiWl.winRateExcludingBreakeven;
  const differenceDetected = apiModeTrades.length !== allAuto.length || Math.abs(apiWinRate - reportWinRate) >= 0.001;
  const winRateComparison = {
    allTrades: {
      count: apiModeTrades.length,
      winRate: apiWinRate,
      description: "report対象外も含む全有効取引"
    },
    reportTargetTrades: {
      count: allAuto.length,
      winRate: reportWinRate,
      description: "monthly report対象。auto-* と新ロジックの保護決済を含む"
    },
    newLogicLoose: {
      count: logicSplit.newLogicLooseSummary.totalTrades,
      winRate: logicSplit.newLogicLooseSummary.winRate,
      description: "新ロジック判定あり。ログ一部欠損を含む"
    },
    newLogicStrict: {
      count: logicSplit.newLogicStrictSummary.totalTrades,
      winRate: logicSplit.newLogicStrictSummary.winRate,
      description: "entryEvidenceScore / entryLocationScore / multiTimeframeScore / decisionTrace が揃った完全ログ付き新ロジック"
    }
  };
  const oos = summarizeAdvanced(split.oos, init);
  const oosPosition = summarizePositions(split.oos, init);
  const stress15 = summarizeAdvanced(applyStress(allAuto, { spreadMul: 1.5, slippageMul: 1.5, rejectMul: 1.5 }), init);
  const stress20 = summarizeAdvanced(applyStress(allAuto, { spreadMul: 2.0, slippageMul: 2.0, rejectMul: 2.0 }), init);
  const stress15Position = summarizePositions(applyStress(allAuto, { spreadMul: 1.5, slippageMul: 1.5, rejectMul: 1.5 }), init);
  const stress20Position = summarizePositions(applyStress(allAuto, { spreadMul: 2.0, slippageMul: 2.0, rejectMul: 2.0 }), init);
  const baseTrades = allAuto.filter((t) => String(t.tradeMode || "BASE").toUpperCase() === "BASE");
  const semiTrades = allAuto.filter((t) => String(t.tradeMode || "BASE").toUpperCase() === "SEMI");
  const fullTrades = allAuto.filter((t) => {
    const m = String(t.tradeMode || "BASE").toUpperCase();
    return m === "FULL" || m === "AGGRESSIVE";
  });
  const aggressiveTrades = allAuto.filter((t) => {
    const m = String(t.tradeMode || "BASE").toUpperCase();
    return m === "SEMI" || m === "FULL" || m === "AGGRESSIVE";
  });
  const aggressiveShare = allAuto.length > 0 ? aggressiveTrades.length / allAuto.length : 0;
  const aggressiveKpi = summarizeModeKpi(aggressiveTrades, init);
  const semiKpi = summarizeModeKpi(semiTrades, init);
  const fullKpi = summarizeModeKpi(fullTrades, init);
  const baseKpi = summarizeModeKpi(baseTrades, init);
  const allMfe = allAuto.map((t) => Number(t.mfeR || 0)).filter((x) => Number.isFinite(x) && x > 0);
  const allFinalSize = allAuto.map((t) => Number(t.finalSizeMultiplier || t.sizingMultiplier || 1)).filter(Number.isFinite);
  const monthlySlippageAdjusted = slippageAdjustedSummary(allAuto, init);
  const monthlySlippageAdjustedPosition = summarizePositions(applyStress(allAuto, { spreadMul: 1, slippageMul: 1.5, rejectMul: 1 }), init);
  const scalingEvents = allLogs.filter((a) => String(a.event || "").startsWith("capitalScaling."));
  const maxDdPct = init > 0 ? (Number(oos.maxDrawdownJpy || 0) / init) * 100 : 0;
  const checks = {
    tradeCount: allAuto.length >= 120,
    oosPfMin: Number(oos.profitFactor || 0) >= 1.20,
    oosExpectancyMin: Number(oos.expectancyR || 0) >= 0.04,
    maxDdCap: maxDdPct <= 6,
    baseModePf: Number(baseKpi.profitFactor || 0) >= 1.10,
    semiModePf: Number(semiKpi.profitFactor || 0) >= 1.05,
    fullModePf: Number(fullKpi.profitFactor || 0) >= 1.00
  };
  const goDecision = Object.values(checks).every(Boolean) ? "GO" : "NO-GO";
  const lossToWinPenalty = clamp(Number(positionSummary.positionAvgLossToAvgWinRatio || 0) / 2, 0, 2);
  const normalizedNetProfit = clamp(Number(positionSummary.positionNetProfitJpy || 0) / Math.max(1, init * 0.01), -2, 2);
  const normalizedDrawdown = clamp(Number(positionSummary.positionMaxDrawdownJpy || 0) / Math.max(1, init * 0.01), 0, 3);
  const evidenceValues = allAuto.map((t) => Number(t.entryEvidenceScore || 0)).filter(Number.isFinite);
  const evidenceQualityScore = average(evidenceValues);
  const profitOptimizationScore = Number((
    Number(positionSummary.positionProfitFactor || 0) * 0.30
    + Number(monthlySlippageAdjustedPosition.positionProfitFactor || 0) * 0.30
    + normalizedNetProfit * 0.20
    - normalizedDrawdown * 0.10
    - lossToWinPenalty * 0.05
    + evidenceQualityScore * 0.05
  ).toFixed(4));
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    reportDataSourceDiagnostics: sourceDiagnostics,
    winLossDiagnostics: {
      ...winLossRows,
      positionWins: winLossPositions.wins,
      positionLosses: winLossPositions.losses,
      positionBreakeven: winLossPositions.breakeven,
      positionUnknown: winLossPositions.unknown,
      positionWinRateByTotal: winLossPositions.winRateByTotal,
      positionWinRateExcludingBreakeven: winLossPositions.winRateExcludingBreakeven
    },
    allTradesSummary: summarizeTradeSet(apiModeTrades, init),
    reportTargetSummary: base,
    excludedTradesSummary: summarizeExcludedTrades(excludedTradeRows, init),
    latestTradesDiagnostics: latestTradeDiagnostics(allTradeRows, includedMonthlySet, 20),
    reportStalenessDiagnostics: {
      reportGeneratedAt: now.toISOString(),
      latestLoadedTradeExitTime: loadedEventTimes.length ? new Date(Math.max(...loadedEventTimes)).toISOString() : null,
      latestFilteredTradeExitTime: eventTimes.length ? new Date(Math.max(...eventTimes)).toISOString() : null,
      latestExcludedTradeExitTime: excludedEventTimes.length ? new Date(Math.max(...excludedEventTimes)).toISOString() : null,
      latestApiTradeExitTime: apiModeTrades.length ? new Date(Math.max(...apiModeTrades.map(tradeTimestampMs).filter(Boolean))).toISOString() : null,
      reportIsStale: loadedEventTimes.length && eventTimes.length ? Math.max(...loadedEventTimes) > Math.max(...eventTimes) : false,
      staleReason: loadedEventTimes.length && eventTimes.length && Math.max(...loadedEventTimes) > Math.max(...eventTimes)
        ? "latest_loaded_trade_is_excluded_from_report_target"
        : null
    },
    summary: base,
    tradeRowSummary: base,
    positionSummary,
    tradeRowWinRate: winLossRows.winRateExcludingBreakeven,
    positionWinRate: winLossPositions.winRateExcludingBreakeven,
    tradeRowProfitFactor: base.profitFactor,
    positionProfitFactor: positionSummary.positionProfitFactor,
    partialExitRows: allAuto.filter((t) => t.partialExitApplied || t.exitTrace?.partialExitApplied || String(t.exitReason || "").includes("partial")).length,
    fullExitRows: allAuto.filter((t) => !(t.partialExitApplied || t.exitTrace?.partialExitApplied || String(t.exitReason || "").includes("partial"))).length,
    groupedPositionCount: positions.length,
    positionGroupingKeyUsed: "positionId || positionKey || signalId:entryTime:side:entryPrice",
    newLogicDefinition: logicSplit.newLogicDefinition,
    newLogicSummary: logicSplit.newLogicSummary,
    newLogicLooseSummary: logicSplit.newLogicLooseSummary,
    newLogicStrictSummary: logicSplit.newLogicStrictSummary,
    newLogicWinRateDiagnostics: logicSplit.newLogicWinRateDiagnostics,
    legacyLogicSummary: logicSplit.legacyLogicSummary,
    missingDiagnostics: logicSplit.missingDiagnostics,
    slippageAdjustedTradeRowPF: monthlySlippageAdjusted.profitFactor,
    slippageAdjustedPositionPF: monthlySlippageAdjustedPosition.positionProfitFactor,
    profitOptimizationScore,
    oos: oos,
    oosPosition,
    bySession: summarizeByFn(allAuto, (t) => sessionDiagnosticsForTrade(t).detectedSession, init),
    sessionDiagnostics,
    bySessionDiagnostics: {
      timezoneUsed: "JST",
      sessionRules: SESSION_RULES_JST,
      londonTradesTimeRangeJST: timeRangeJstForSession(allAuto, "LONDON"),
      tokyoTradesTimeRangeJST: timeRangeJstForSession(allAuto, "TOKYO"),
      detectedSessionCounts: groupedCount(sessionDiagnostics, (d) => d.detectedSession),
      originalSessionCounts: groupedCount(allAuto, (t) => t.executionSession || t.session || "UNKNOWN")
    },
    byRegime: summarizeBy(allAuto, "regime", init),
    bySignalStrength: summarizeBySignalStrength(allAuto, init),
    byEventTag: summarizeBy(allAuto, "executionEventTag", init),
    byMode: summarizeBy(allAuto, "tradeMode", init),
    byCapitalTier: summarizeByCapitalTier(allAuto, init, state?.capitalScalingRuntime?.activeTierId || "UNKNOWN"),
    sizingAverages: summarizeSizingFields(allAuto),
    byDecisionCategory: summarizeByFn(allAuto, (t) => categoryForLogic(t, t.decisionCategory || t.entryEvidenceBreakdown?.finalCategory), init),
    byDecisionCategoryLegacyAlias: {
      missingDiagnostics: summarizeByFn(
        allAuto.filter((t) => hasNewLogicMarkers(t) && !(t.decisionCategory || t.entryEvidenceBreakdown?.finalCategory)),
        () => "missingDiagnostics",
        init
      ).missingDiagnostics || null
    },
    byEntryEvidenceScore: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => scoreBandForLogic(t, firstFinite(t.entryEvidenceScore, t.entryEvidenceBreakdown?.totalScore)))).map(([k, count]) => [k, { count }])),
    byProbeLowRate: summarizeBy(allAuto, "probeLowRateApplied", init),
    byMultiTimeframeScore: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => scoreBandForLogic(t, firstFinite(t.multiTimeframeScore, t.multiTimeframeDiagnostics?.multiTimeframeScore)))).map(([k, count]) => [k, { count }])),
    byShortTermAlignment: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => scoreBand(t.shortTermAlignmentScore))).map(([k, count]) => [k, { count }])),
    byShortTermExhaustion: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => scoreBand(1 - Number(t.shortTermExhaustionScore || 0)))).map(([k, count]) => [k, { count }])),
    byTrendUpEntryQuality: groupedCount(allAuto, entryLocationCategoryOf),
    byTrendUpEntryTiming: groupedCount(allAuto, (t) => t.trendUpEntryQuality?.entryTimingCategory || t.entryLocationDiagnostics?.entryLocationCategory || "UNKNOWN"),
    byLateEntryDetected: groupedCount(allAuto, (t) => boolBand(t.lateEntryDiagnostics?.lateEntryDetected, "late", "notLate")),
    byEarlyAdverseMove: groupedCount(allAuto, (t) => boolBand(t.exitTrace?.quickAdverseMoveExit || t.exitTrace?.earlyFailureExit, "earlyAdverse", "normal")),
    byQuickAdverseMoveExit: groupedCount(allAuto, (t) => String(t.exitReason || "").includes("quick-adverse") ? "quickAdverse" : "other"),
    byNoFollowThroughExit: groupedCount(allAuto, (t) => String(t.exitReason || "").includes("no-follow-through") ? "noFollowThrough" : "other"),
    byFastPeakProtect: groupedCount(allAuto, (t) => String(t.exitReason || "").includes("peak-protect") || t.exitTrace?.fastProtectTriggered ? "protected" : "other"),
    byEntryLocationScore: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => scoreBandForLogic(t, entryLocationScoreOf(t)))).map(([k, count]) => [k, { count }])),
    byEntryLocationCategory: groupedCount(allAuto, entryLocationCategoryOf),
    byEntryLocationCategoryAndExitReason: summarizeCrossByFn(allAuto, entryLocationCategoryOf, (t) => t.exitReason || "UNKNOWN", init),
    byEntryLocationScoreAndExitReason: summarizeCrossByFn(allAuto, (t) => scoreBandForLogic(t, entryLocationScoreOf(t)), (t) => t.exitReason || "UNKNOWN", init),
    byQuickAdverseRiskScore: summarizeByFn(allAuto, (t) => scoreBandForLogic(t, quickAdverseRiskScoreOf(t)), init),
    byQuickAdverseRiskScoreAndExitReason: summarizeCrossByFn(allAuto, (t) => scoreBandForLogic(t, quickAdverseRiskScoreOf(t)), (t) => t.exitReason || "UNKNOWN", init),
    byPullbackQuality: summarizeByFn(allAuto, pullbackQualityOf, init),
    byPullbackQualityAndExitReason: summarizeCrossByFn(allAuto, pullbackQualityOf, (t) => t.exitReason || "UNKNOWN", init),
    byTrendUpEntryQualityAndPnL: summarizeByFn(allAuto, entryLocationCategoryOf, init),
    entryQualityIssueDiagnostics: summarizeEntryQualityIssues(allAuto, init),
    byFinalSizeMultiplier: Object.fromEntries(Object.entries(groupedCount(allAuto, (t) => sizeMultiplierBand(finalSizeMultiplierOf(t)))).map(([k, count]) => [k, { count }])),
    byExitRule: summarizeBy(allAuto, "exitReason", init),
    byDecisionTraceStage: groupedCount(allAuto.flatMap((t) => Array.isArray(t.decisionTrace?.stages) ? t.decisionTrace.stages : []), (s) => `${s.name}:${s.status}`),
    blockReasonSummary: groupedCount(allSkips, (a) => a.reason || "UNKNOWN"),
    byBlockedStage: groupedCount(allSkips, (a) => a.blockedStage || a.reason || "UNKNOWN"),
    byNoActionableSignalCategory: groupedCount(allSkips.filter(isNoActionableSkip), (a) => a.noActionableSignalDiagnostics?.category || "UNKNOWN"),
    preTradeGuardDiagnosticsSummary: buildPreTradeGuardDiagnosticsSummary(allSkips),
    noActionableSignalDiagnosticsSummary: buildNoActionableSignalDiagnosticsSummary(allSkips),
    blockRates: {
      preTradeGuard: Number((allSkips.length > 0 ? (allSkips.filter(isPreTradeSkip).length / allSkips.length) : 0).toFixed(4)),
      reentryGuard: Number((allSkips.length > 0 ? (allSkips.filter(isReentrySkip).length / allSkips.length) : 0).toFixed(4))
    },
    reportConsistencyDiagnostics: {
      apiTradesCount: apiModeTrades.length,
      reportTradesCount: allAuto.length,
      excludedRows: excludedTradeRows.length,
      excludedReasonSummary: sourceDiagnostics.excludedReasonSummary,
      includedReasonSummary: sourceDiagnostics.includedReasonSummary,
      reportTargetRule: sourceDiagnostics.reportTargetRule,
      apiWinRate,
      reportWinRate,
      allTradesSummary: summarizeTradeSet(apiModeTrades, init),
      reportTargetSummary: base,
      excludedTradesSummary: summarizeExcludedTrades(excludedTradeRows, init),
      winRateComparison,
      differenceDetected,
      currentReportRuleIsAlignedWithApi: apiModeTrades.length === allAuto.length,
      noteForReview: "セイへ渡す月次確認では logs/monthly_report_202605.json の reportConsistencyDiagnostics / newLogicWinRateDiagnostics / entryQualityIssueDiagnostics / byEntryLocationCategoryAndExitReason を優先して確認する",
      possibleReasons: [
        ...(apiModeTrades.length !== allAuto.length ? ["some_valid_trades_are_outside_report_target_rule_check_excludedReasonSummary"] : []),
        ...(allAuto.some((t) => t.partialExitApplied || t.exitTrace?.partialExitApplied || String(t.exitReason || "").includes("partial")) ? ["partial_exit_counted_as_trade_row"] : []),
        ...((winLossRows.breakeven + winLossRows.unknown) > 0 ? ["breakeven_or_unknown_rows"] : []),
        ...(logicSplit.legacyLogicSummary.totalTrades > 0 && logicSplit.newLogicSummary.totalTrades > 0 ? ["legacy_and_new_logic_mixed"] : []),
        ...(Object.keys(groupedCount(allAuto, (t) => t.executionSession || "UNKNOWN")).some((k) => k !== "UNKNOWN") ? ["session_timezone_mismatch_possible_check_bySessionDiagnostics"] : []),
        ...(sourceDiagnostics.latestTradeExitTime ? [] : ["report_not_regenerated_after_latest_trades"])
      ]
    },
    slippageAdjusted: {
      profitFactor: monthlySlippageAdjusted.profitFactor === null ? null : Number(monthlySlippageAdjusted.profitFactor.toFixed(4)),
      expectancyR: Number(monthlySlippageAdjusted.expectancyR || 0),
      netExpectancyPips: Number(monthlySlippageAdjusted.expectancyR || 0),
      netProfitJpy: Number(monthlySlippageAdjusted.netProfitJpy || 0)
    },
    modeBreakdown: {
      aggressiveShare: Number(aggressiveShare.toFixed(4)),
      baseTrades: baseTrades.length,
      semiTrades: semiTrades.length,
      fullTrades: fullTrades.length,
      aggressiveTrades: aggressiveTrades.length,
      base: baseKpi,
      semi: semiKpi,
      full: fullKpi,
      aggressive: aggressiveKpi,
      mfeR: {
        p50: Number(percentile(allMfe, 0.5).toFixed(4)),
        p80: Number(percentile(allMfe, 0.8).toFixed(4)),
        p90: Number(percentile(allMfe, 0.9).toFixed(4))
      },
      finalSizeMultiplier: {
        p10: Number(percentile(allFinalSize, 0.1).toFixed(4)),
        p50: Number(percentile(allFinalSize, 0.5).toFixed(4)),
        p90: Number(percentile(allFinalSize, 0.9).toFixed(4))
      }
    },
    capitalScaling: {
      activeTierId: state?.capitalScalingRuntime?.activeTierId || "UNKNOWN",
      candidateTierId: state?.capitalScalingRuntime?.candidateTierId || "UNKNOWN",
      promotionCount: scalingEvents.filter((a) => String(a.event || "").includes("tier_promoted")).length,
      demotionCount: scalingEvents.filter((a) => String(a.event || "").includes("tier_demoted")).length,
      fullTrialTrades: fullTrades.filter((t) => t?.positionSizingDiagnostics?.capitalScalingDiagnostics?.fullTrialApplied).length,
      fullTrialPF: summarizeAdvanced(fullTrades.filter((t) => t?.positionSizingDiagnostics?.capitalScalingDiagnostics?.fullTrialApplied), init).profitFactor,
      eventSummary: groupedCount(scalingEvents, (a) => a.event)
    },
    lowDdSteadyGate: {
      checks,
      goDecision
    },
    stress: {
      x1_5: stress15,
      x2_0: stress20,
      x1_5Position: stress15Position,
      x2_0Position: stress20Position
    }
  };
  const file = writeJson(`monthly_report_${ym(now.toISOString())}.json`, payload);
  return { ...payload, file };
}

export function buildAblationReport(state, ablationText = "") {
  const flags = new Set(String(ablationText || "").split(",").map((x) => x.trim()).filter(Boolean));
  const trades = sortedAutoTrades(state);
  const logs = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
  const opened = logs.filter((a) => a.event === "auto.position.opened").length;
  const skips = logs.filter((a) => a.event === "auto.skip").length;
  const base = summarizeAdvanced(trades, Number(state?.account?.initialBalanceJpy || 1_000_000));
  const init = Number(state?.account?.initialBalanceJpy || 1_000_000);

  const passRateBase = (opened + skips) > 0 ? opened / (opened + skips) : 0;
  const passRateAdj = clamp(
    passRateBase
      + (flags.has("tailPenaltyOff") ? 0.06 : 0)
      + (flags.has("noTradeOff") ? 0.04 : 0)
      + (flags.has("preTradeLoose") ? 0.03 : 0)
      + (flags.has("aggressiveOff") ? -0.02 : 0)
      + (flags.has("fullOff") ? -0.01 : 0)
      + (flags.has("semiOff") ? -0.008 : 0),
    0,
    1
  );
  const tradesAdj = Math.round(base.totalTrades * (passRateBase > 0 ? passRateAdj / Math.max(0.01, passRateBase) : 1));
  const expectancyAdj = Number((
    Number(base.expectancyR || 0)
    + (flags.has("tailPenaltyOff") ? -0.01 : 0)
    + (flags.has("noTradeOff") ? -0.006 : 0)
    + (flags.has("aggressiveOff") ? -0.02 : 0)
    + (flags.has("fullOff") ? -0.015 : 0)
    + (flags.has("semiOff") ? -0.008 : 0)
  ).toFixed(6));
  const pfAdj = base.profitFactor === null ? null : Number((
    Number(base.profitFactor)
    + (flags.has("tailPenaltyOff") ? -0.03 : 0)
    + (flags.has("aggressiveOff") ? -0.04 : 0)
    + (flags.has("fullOff") ? -0.025 : 0)
    + (flags.has("semiOff") ? -0.015 : 0)
  ).toFixed(4));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    ablation: [...flags],
    baseline: {
      tradeCount: base.totalTrades,
      passRate: Number(passRateBase.toFixed(4)),
      netProfitJpy: Number(base.netProfitJpy || 0),
      profitFactor: base.profitFactor === null ? null : Number(base.profitFactor.toFixed(4)),
      expectancyR: Number(base.expectancyR || 0),
      maxDrawdownJpy: Number(base.maxDrawdownJpy || 0)
    },
    bySession: summarizeBy(trades, "executionSession", init),
    byRegime: summarizeBy(trades, "regime", init),
    byEventTag: summarizeBy(trades, "executionEventTag", init),
    simulated: {
      tradeCount: tradesAdj,
      passRate: Number(passRateAdj.toFixed(4)),
      netProfitJpy: Number((Number(base.netProfitJpy || 0) * (tradesAdj / Math.max(1, base.totalTrades))).toFixed(2)),
      profitFactor: pfAdj,
      expectancyR: expectancyAdj,
      maxDrawdownJpy: Number((Number(base.maxDrawdownJpy || 0) * (1 + (flags.size * 0.08))).toFixed(2))
    },
    note: "Ablation is a deterministic approximation from existing logs/trades; use for directionality, not final acceptance."
  };
}

export function loadLatestReport(prefix) {
  ensureLogDir();
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort();
    if (!files.length) return null;
    const latest = files[files.length - 1];
    const path = resolve(LOG_DIR, latest);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
