export function evaluateFinalSizingGuard({
  qty,
  diagnostics = {},
  executionMode = "PAPER_LIVE",
  availableCapitalJPY = null,
  requireStopLoss = false
} = {}) {
  const d = diagnostics || {};
  const reasons = [];
  const q = Number(qty);
  const units = Number(d.calculatedUnits || 0);
  const minUnits = Math.max(1, Number(d.brokerMinUnits ?? d.minUnits ?? 1));
  const maxUnits = Math.max(minUnits, Number(d.maxUnits ?? Number.MAX_SAFE_INTEGER));
  const maxEffectiveLeverage = Math.max(1, Number(d.maxEffectiveLeverage ?? 20));
  const legalMaxLeverage = Math.max(1, Number(d.legalMaxLeverage ?? 25));
  const requiredMarginJPY = Number(d.requiredMarginJPY || 0);
  const capital = Number(availableCapitalJPY ?? d.balanceJPY ?? 0);
  const estimatedLossJPY = Number(d.estimatedLossJPY || 0);
  const maxRiskAmountJPY = Math.max(0, Number(d.maxRiskAmountJPY ?? Number.MAX_SAFE_INTEGER));
  const riskAmountJPY = Number(d.riskAmountJPY || 0);
  const balanceJPY = Number(d.balanceJPY || 0);
  const hardBlockRiskPercentPerTrade = Math.max(0.1, Number(d.hardBlockRiskPercentPerTrade ?? 15));
  const stopLossPips = Number(d.stopLossPips || 0);
  const liveMode = String(executionMode || "").toUpperCase() === "LIVE";

  if (!(q > 0)) reasons.push("qty_invalid");
  if (!(units >= minUnits)) reasons.push("calculatedUnits_below_broker_minUnits");
  if (units > maxUnits) reasons.push("calculatedUnits_over_maxUnits");
  if (Number(d.effectiveLeverage || 0) > maxEffectiveLeverage) reasons.push("effectiveLeverage_over_max");
  if (Number(d.effectiveLeverage || 0) > legalMaxLeverage || legalMaxLeverage > 25) reasons.push("legal_leverage_over_25");
  if (requiredMarginJPY > capital) reasons.push("requiredMargin_over_availableCapital");
  if (estimatedLossJPY > maxRiskAmountJPY) reasons.push("estimatedLoss_over_maxRiskAmount");
  if (balanceJPY > 0 && riskAmountJPY > balanceJPY * (hardBlockRiskPercentPerTrade / 100)) reasons.push("riskPercent_over_hardBlock");
  if (!(stopLossPips > 0)) reasons.push("stopLossPips_invalid");
  if (requireStopLoss || liveMode) {
    if (d.stopLossFallbackUsed || d.stopLossSource === "fallback") reasons.push("stopLoss_required_for_live");
  }
  if (q > 0 && units > 0 && Math.round(q) !== Math.round(units)) reasons.push("qty_mismatch_calculatedUnits");
  if (d.blockedReason) reasons.push(d.blockedReason);

  return {
    allowed: reasons.length === 0,
    reasons,
    reason: reasons[0] || "final sizing guard passed",
    executionMode: String(executionMode || "PAPER_LIVE").toUpperCase()
  };
}
