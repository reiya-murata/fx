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

function suggestedFixFor({ finalCategory, finalBlockStage, preTradeGuardAllowed, positionSizingBlockedReason }) {
  if (finalCategory === "PROBE_CANDIDATE") {
    return "PROBE候補は実行対象にせず、記録専用にするか基準を再確認してください";
  }
  if (finalBlockStage === "pre_trade_guard" || preTradeGuardAllowed === false) {
    return "preTradeGuard の confidence / spread / executionStress を確認してください";
  }
  if (finalBlockStage === "context_validation") {
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
  const finalBlockStage = blockedStage || (finalAction === "HOLD" ? "signal_generation" : "none");
  const finalReason = decisionTrace.finalReason || noActionable.reason || input.lastSkipReason || "unknown";
  const finalCategory = entryEvidenceBreakdown.finalCategory || noActionable.category || "UNKNOWN";
  const preTradeGuardAllowed = typeof input.preTradeGuard?.allowed === "boolean"
    ? input.preTradeGuard.allowed
    : null;
  const positionSizingBlockedReason = positionSizingDiagnostics.blockedReason || finalSizingGuard.reason || "";
  const reasonJa = translateReasonToJa(finalReason);

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
    contextValidationMode: contextValidation.mode || contextValidation.status || "UNKNOWN",
    positionSizingBlockedReason,
    shouldInvestigate,
    suggestedFix: suggestedFixFor({
      finalCategory,
      finalBlockStage,
      preTradeGuardAllowed,
      positionSizingBlockedReason
    })
  };
}
