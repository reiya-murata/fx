import { analyticsSummary } from "./analytics.js";
import { computeObjectiveScore } from "./objective.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function formatUnitsText(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const rounded = Math.round(n);
  if (rounded < 10000) return `${rounded.toLocaleString("ja-JP")}通貨`;
  const man = rounded / 10000;
  return `${man.toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  })}万通貨`;
}

export function calculateUsdJpyPositionSizing({
  settings = {},
  stopLossPips,
  currentUsdJpyPrice,
  leverage = 25,
  sizeMultiplier = 1,
  maxUnitsOverride = null,
  minUnitsOverride = null
} = {}) {
  const balanceJPY = Number(settings.balanceJPY ?? 10000);
  const sizingMode = String(settings.sizingMode || "riskPercent");
  const riskPercentPerTrade = Number(settings.riskPercentPerTrade ?? settings.autoRiskPercentPerTrade ?? 1);
  const fixedRiskAmountJPY = Number(settings.riskAmountJPY ?? 100);
  const maxEffectiveLeverage = Number(settings.maxEffectiveLeverage ?? 20);
  const legalMaxLeverage = Number(settings.legalMaxLeverage ?? 25);
  const requiredMarginRate = Number(settings.requiredMarginRate ?? 0.04);
  const brokerMinUnits = Math.max(1, Math.round(Number(minUnitsOverride ?? settings.brokerMinUnits ?? settings.minUnits ?? 100)));
  const minUnits = brokerMinUnits;
  const unitStep = Math.max(1, Math.round(Number(settings.unitStep ?? 1)));
  const configuredMaxUnits = Math.max(minUnits, Math.round(Number(settings.maxUnits ?? 50000)));
  const maxUnits = Math.max(minUnits, Math.round(Number(maxUnitsOverride ?? configuredMaxUnits)));
  const selectedRiskProfile = String(settings.selectedRiskProfile || settings.riskProfile || "smallCapitalAggressive");
  const maxRiskAmountJPY = Math.max(1, Number(settings.maxRiskAmountJPY ?? 1000));
  const hardBlockRiskPercentPerTrade = Math.max(0.1, Number(settings.hardBlockRiskPercentPerTrade ?? 3));
  const slPips = Number(stopLossPips);
  const price = Number(currentUsdJpyPrice);
  const marginLeverage = Math.max(1, Number(leverage || 25));
  const requestedRiskAmountJPY = sizingMode === "fixedRiskJPY"
    ? fixedRiskAmountJPY
    : balanceJPY * riskPercentPerTrade / 100;
  const roundDownToStep = (units) => Math.floor(Math.max(0, Number(units || 0)) / unitStep) * unitStep;
  const maxEffectiveLeverageUnits = price > 0
    ? roundDownToStep((balanceJPY * maxEffectiveLeverage) / price)
    : 0;
  const legalMaxUnits = price > 0
    ? roundDownToStep((balanceJPY * legalMaxLeverage) / price)
    : 0;

  const base = {
    balanceJPY,
    sizingMode: sizingMode === "fixedRiskJPY" ? "fixedRiskJPY" : "riskPercent",
    riskPercentPerTrade,
    riskAmountJPY: Number(requestedRiskAmountJPY.toFixed(2)),
    stopLossPips: Number(Number.isFinite(slPips) ? slPips.toFixed(4) : 0),
    calculatedUnits: 0,
    displayUnitsText: "-",
    pipValueJPY: 0,
    estimatedLossJPY: 0,
    estimatedExposureJPY: 0,
    requiredMarginJPY: 0,
    effectiveLeverage: 0,
    maxEffectiveLeverage,
    legalMaxLeverage,
    requiredMarginRate,
    minUnits,
    brokerMinUnits,
    unitStep,
    maxUnits,
    selectedRiskProfile,
    maxRiskAmountJPY,
    hardBlockRiskPercentPerTrade,
    rawUnitsBeforeMultiplier: 0,
    unitsAfterMultiplier: 0,
    unitsAfterLeverageCap: 0,
    legalMaxUnits,
    maxEffectiveLeverageUnits,
    cappedByMaxUnits: false,
    cappedByLeverage: false,
    leverageCapped: false,
    minUnitsBlocked: false,
    legalLeverageBlocked: false,
    blockedReason: null
  };

  if (!(balanceJPY > 0)) return { ...base, blockedReason: "balanceJPY_invalid" };
  if (!(slPips > 0)) return { ...base, blockedReason: "stopLossPips_invalid" };
  if (!(price > 0)) return { ...base, blockedReason: "current_price_invalid" };
  if (!(requestedRiskAmountJPY > 0)) return { ...base, blockedReason: "riskAmountJPY_invalid" };
  if (legalMaxLeverage > 25 || maxEffectiveLeverage > 25 || marginLeverage > 25 || requiredMarginRate < 0.04) {
    return { ...base, legalLeverageBlocked: true, blockedReason: "legal_leverage_over_25" };
  }
  if (requestedRiskAmountJPY > balanceJPY * (hardBlockRiskPercentPerTrade / 100)) {
    return {
      ...base,
      blockedReason: hardBlockRiskPercentPerTrade === 3
        ? "riskAmountJPY_over_3_percent"
        : "riskAmountJPY_over_hard_percent"
    };
  }
  if (requestedRiskAmountJPY > maxRiskAmountJPY) {
    return { ...base, blockedReason: "riskAmountJPY_over_profile_max" };
  }

  const rawUnits = requestedRiskAmountJPY / (slPips * 0.01);
  let units = roundDownToStep(rawUnits * clamp(Number(sizeMultiplier || 1), 0, 10));
  const unitsAfterMultiplier = units;
  let cappedByMaxUnits = false;
  let cappedByLeverage = false;
  if (units > maxUnits) {
    units = roundDownToStep(maxUnits);
    cappedByMaxUnits = true;
  }
  if (Number.isFinite(maxEffectiveLeverageUnits) && units > maxEffectiveLeverageUnits) {
    units = maxEffectiveLeverageUnits;
    cappedByLeverage = true;
  }
  const unitsAfterLeverageCap = units;
  if (Number.isFinite(legalMaxUnits) && legalMaxUnits > 0 && units > legalMaxUnits) {
    return {
      ...base,
      rawUnitsBeforeMultiplier: Number(rawUnits.toFixed(2)),
      unitsAfterMultiplier,
      unitsAfterLeverageCap,
      cappedByMaxUnits,
      cappedByLeverage,
      leverageCapped: cappedByLeverage,
      legalLeverageBlocked: true,
      calculatedUnits: units,
      displayUnitsText: formatUnitsText(units),
      blockedReason: "legal_leverage_over_25"
    };
  }
  if (units < minUnits) {
    let blockedReason = "calculatedUnits_below_broker_minUnits";
    if (cappedByLeverage) blockedReason = "leverage_cap_makes_units_below_minUnits";
    else if (legalMaxUnits > 0 && legalMaxUnits < minUnits) blockedReason = "balance_too_small_for_minUnits";
    else if (unitsAfterMultiplier < minUnits) blockedReason = "risk_too_small_for_minUnits";
    return {
      ...base,
      rawUnitsBeforeMultiplier: Number(rawUnits.toFixed(2)),
      unitsAfterMultiplier,
      unitsAfterLeverageCap,
      cappedByMaxUnits,
      cappedByLeverage,
      leverageCapped: cappedByLeverage,
      minUnitsBlocked: true,
      calculatedUnits: Math.max(0, units),
      displayUnitsText: formatUnitsText(units),
      blockedReason
    };
  }

  const pipValueJPY = units * 0.01;
  const estimatedExposureJPY = units * price;
  const requiredMarginJPY = estimatedExposureJPY / marginLeverage;
  const effectiveLeverage = estimatedExposureJPY / balanceJPY;
  const estimatedLossJPY = slPips * units * 0.01;

  return {
    ...base,
    calculatedUnits: units,
    displayUnitsText: formatUnitsText(units),
    pipValueJPY: Number(pipValueJPY.toFixed(2)),
    estimatedLossJPY: Number(estimatedLossJPY.toFixed(2)),
    estimatedExposureJPY: Number(estimatedExposureJPY.toFixed(2)),
    requiredMarginJPY: Number(requiredMarginJPY.toFixed(2)),
    effectiveLeverage: Number(effectiveLeverage.toFixed(4)),
    rawUnitsBeforeMultiplier: Number(rawUnits.toFixed(2)),
    unitsAfterMultiplier,
    unitsAfterLeverageCap,
    cappedByMaxUnits,
    cappedByLeverage,
    leverageCapped: cappedByLeverage,
    legalLeverageBlocked: effectiveLeverage > legalMaxLeverage,
    blockedReason: effectiveLeverage > legalMaxLeverage
      ? "legal_leverage_over_25"
      : (effectiveLeverage > maxEffectiveLeverage ? "effectiveLeverage_over_max" : null)
  };
}

export function optimizePositionSize({ signal, trades, cfg = {}, objectiveCfg = {} }) {
  if (!Boolean(cfg.enabled)) {
    return {
      enabled: false,
      sizeMultiplier: 1,
      reason: "sizing disabled"
    };
  }
  const list = (Array.isArray(trades) ? [...trades] : [])
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0))
    .slice(-Math.max(20, Number(cfg.lookbackTrades || 90)));
  const minTrades = Math.max(5, Number(cfg.minTrades || 20));
  if (list.length < minTrades) {
    return {
      enabled: true,
      pending: true,
      sizeMultiplier: 1,
      reason: `sizing pending: ${list.length}/${minTrades}`
    };
  }
  const s = analyticsSummary(list);
  const wins = list.filter((t) => Number(t.netPnlJpy || 0) > 0).map((t) => Number(t.netPnlJpy || 0));
  const losses = list.filter((t) => Number(t.netPnlJpy || 0) < 0).map((t) => Math.abs(Number(t.netPnlJpy || 0)));
  const p = clamp(Number(s.winRate || 0), 0.05, 0.95);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : Math.max(1, avgWin);
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kellyRaw = b > 0 ? (p * (b + 1) - 1) / b : -0.2;
  const maxKellyFraction = clamp(Number(cfg.maxKellyFraction || 0.35), 0.05, 1);
  const kelly = clamp(kellyRaw, -0.5, maxKellyFraction);
  const ddPenalty = clamp((Number(s.maxDrawdownJpy || 0) / Math.max(1, Math.abs(Number(s.netProfitJpy || 1)))) * Number(cfg.drawdownPenaltyScale || 1.2), 0, 2.5);
  const expectedValuePips = Number(signal?.metrics?.expectedValuePips || 0);
  const evBoost = clamp(expectedValuePips / 1.2, -0.35, 0.45);
  const avgCostJpy = list.length > 0
    ? list.reduce((sum, t) => sum + Math.max(0, Number(t?.feeJpy || 0)), 0) / list.length
    : 0;
  const objective = computeObjectiveScore({ summary: s, avgCostJpy, cfg: objectiveCfg });
  const objectiveBoost = clamp((Number(objective.normalized || 0.5) - 0.5) * 0.55, -0.2, 0.25);
  const rawMult = 0.9 + kelly * 1.15 + evBoost - ddPenalty * 0.22 + objectiveBoost;
  const sizeMultiplier = clamp(
    rawMult,
    Number(cfg.minSizeMultiplier || 0.45),
    Number(cfg.maxSizeMultiplier || 1.25)
  );
  return {
    enabled: true,
    pending: false,
    sizeMultiplier: Number(sizeMultiplier.toFixed(4)),
    kelly: Number(kelly.toFixed(4)),
    drawdownPenalty: Number(ddPenalty.toFixed(4)),
    objectiveScore: Number(objective.score || 0),
    objectiveNormalized: Number(objective.normalized || 0.5),
    reason: "continuous sizing"
  };
}
