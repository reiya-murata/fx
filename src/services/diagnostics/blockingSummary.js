import { translateReasonToJa } from "./reasonTranslator.js";

function lastBlockedStageName(decisionTrace) {
  const stages = Array.isArray(decisionTrace?.stages) ? decisionTrace.stages : [];
  const blocked = stages.filter((stage) => String(stage?.status || "").toLowerCase() === "blocked");
  return blocked.length ? String(blocked[blocked.length - 1]?.name || "unknown") : "";
}

function hasMostlyEnglish(text) {
  const s = String(text || "");
  if (!s) return false;
  const asciiLetters = (s.match(/[A-Za-z]/g) || []).length;
  const japanese = (s.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return asciiLetters >= 12 && asciiLetters > japanese;
}

function suggestedFixFor({ finalCategory, finalBlockStage, finalReason, preTradeGuardAllowed, positionSizingBlockedReason, contextValidation }) {
  const reason = String(finalReason || "");
  if (reason.includes("LIVE_DISCONNECTED") || reason.includes("リアルタイム未接続")) {
    return "リアルタイム価格ソース、marketStatus.realtime、tickerのbid/askを確認してください";
  }
  if (finalCategory === "PROBE_CANDIDATE") {
    return "PROBE候補は実行対象にせず、記録専用にするか基準を再確認してください";
  }
  if (finalBlockStage === "pre_trade_guard" || preTradeGuardAllowed === false) {
    return "preTradeGuard の confidence / spread / executionStress を確認してください";
  }
  if (finalBlockStage === "context_validation") {
    const contextSampleCount = Number(contextValidation?.contextSampleCount ?? contextValidation?.exactCount ?? 0);
    const requiredSamples = Number(contextValidation?.requiredSamples ?? 0);
    if (!contextValidation?.contextKey) {
      return "contextKey が取得できていません。contextValidation の診断出力を確認してください";
    }
    if (requiredSamples > 0 && contextSampleCount < requiredSamples) {
      return "この相場コンテキストの検証サンプルが不足しています。PAPER_LIVEで記録を継続し、サンプルが増えるまで実行を抑制してください";
    }
    return "未検証コンテキストの扱いを確認してください";
  }
  if (finalBlockStage === "position_sizing" || positionSizingBlockedReason) {
    return "数量計算・レバレッジ上限・stopLoss の有無を確認してください";
  }
  if (finalBlockStage === "signal_generation") {
    return "売買シグナル生成条件を確認してください";
  }
  return "追加対応不要。ログの推移を確認してください";
}

export function buildBlockingSummary(input = {}) {
  const decisionTrace = input.decisionTrace || {};
  const noActionable = input.noActionableSignalDiagnostics || {};
  const entryEvidenceBreakdown = input.entryEvidenceBreakdown || {};
  const positionSizingDiagnostics = input.positionSizingDiagnostics || {};
  const finalSizingGuard = input.finalSizingGuard || {};
  const contextValidation = input.contextValidationGate || input.contextValidation || {};

  const finalAction = decisionTrace.finalAction || input.lastAction || "UNKNOWN";
  const candidateAction = decisionTrace.candidateAction || noActionable.candidateSide || "UNKNOWN";
  const blockedStage = lastBlockedStageName(decisionTrace);
  let finalBlockStage = blockedStage || (finalAction === "HOLD" ? "signal_generation" : "none");
  const finalReason = decisionTrace.finalReason || noActionable.reason || input.lastSkipReason || "unknown";
  const finalCategory = entryEvidenceBreakdown.finalCategory || noActionable.category || "UNKNOWN";
  const quickAdverseProneDiagnostics = noActionable.quickAdverseProneDiagnostics
    || decisionTrace.stages?.find?.((stage) => stage?.name === "quick_adverse_prone_guard")?.details
    || {};
  const preTradeGuardAllowed = typeof input.preTradeGuard?.allowed === "boolean"
    ? input.preTradeGuard.allowed
    : null;
  const positionSizingBlockedReason = positionSizingDiagnostics.blockedReason || finalSizingGuard.reason || "";
  const marketStatus = input.marketStatus || {};
  const historyReady = typeof marketStatus.historyReady === "boolean" ? marketStatus.historyReady : null;
  const history1mCount = marketStatus.history1mCount ?? null;
  const live1mCount = marketStatus.live1mCount ?? null;
  const historyCount = Number(history1mCount ?? live1mCount);
  const historyInsufficient = historyReady === false || (Number.isFinite(historyCount) && historyCount <= 0);
  if (historyInsufficient) finalBlockStage = "market_history";
  const reasonJa = historyInsufficient
    ? "履歴足データが不足しています。1分足が蓄積されるまで売買判断を停止しています"
    : translateReasonToJa(finalReason);
  const contextSampleCount = contextValidation.contextSampleCount ?? contextValidation.exactCount ?? null;
  const requiredSamples = contextValidation.requiredSamples ?? null;
  const current = Number(contextSampleCount);
  const required = Number(requiredSamples);
  const contextValidationProgress = Number.isFinite(current) && Number.isFinite(required)
    ? {
        current,
        required,
        remaining: Math.max(required - current, 0),
        percent: required > 0 ? Math.min(Math.round((current / required) * 100), 100) : null
      }
    : {
        current: Number.isFinite(current) ? current : null,
        required: Number.isFinite(required) ? required : null,
        remaining: null,
        percent: null
      };

  const shouldInvestigate = finalCategory === "PROBE_CANDIDATE"
    || finalCategory === "WEAK_HOLD"
    || hasMostlyEnglish(reasonJa)
    || preTradeGuardAllowed === false
    || Boolean(positionSizingBlockedReason)
    || finalBlockStage === "context_validation";

  return {
    finalAction,
    candidateAction,
    finalBlockStage,
    finalReason,
    reasonJa,
    entryEvidenceScore: Number(input.entryEvidenceScore ?? entryEvidenceBreakdown.totalScore ?? 0),
    finalCategory,
    preTradeGuardAllowed,
    contextKey: contextValidation.contextKey || "",
    contextSampleCount,
    requiredSamples,
    contextValidationProgress,
    contextValidationReason: contextValidation.validationReason || contextValidation.originalReason || contextValidation.reason || "",
    contextValidationAllowed: typeof contextValidation.allowed === "boolean" ? contextValidation.allowed : null,
    contextValidationMode: contextValidation.validationMode || contextValidation.appliedMode || contextValidation.mode || contextValidation.status || "UNKNOWN",
    contextValidationCollectOnly: Boolean(contextValidation.collectOnly),
    liveAllowed: typeof contextValidation.liveAllowed === "boolean" ? contextValidation.liveAllowed : null,
    knownContext: typeof contextValidation.knownContext === "boolean" ? contextValidation.knownContext : null,
    bootstrapUsed: typeof contextValidation.bootstrapUsed === "boolean" ? contextValidation.bootstrapUsed : null,
    quickAdverseProne: typeof entryEvidenceBreakdown.quickAdverseProne === "boolean"
      ? entryEvidenceBreakdown.quickAdverseProne
      : (typeof quickAdverseProneDiagnostics.prone === "boolean" ? quickAdverseProneDiagnostics.prone : null),
    quickAdverseProneReason: entryEvidenceBreakdown.quickAdverseProneReason || quickAdverseProneDiagnostics.reason || "",
    quickAdversePronePenalty: entryEvidenceBreakdown.quickAdversePronePenalty ?? null,
    historyReady,
    history1mCount,
    live1mCount,
    positionSizingBlockedReason,
    shouldInvestigate,
    suggestedFix: suggestedFixFor({
      finalCategory,
      finalBlockStage,
      finalReason,
      preTradeGuardAllowed,
      positionSizingBlockedReason,
      contextValidation
    })
  };
}
