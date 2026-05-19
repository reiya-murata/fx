function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortedTiers(cfg = {}) {
  return (Array.isArray(cfg.tiers) ? cfg.tiers : [])
    .slice()
    .sort((a, b) => Number(a.minBalanceJPY || 0) - Number(b.minBalanceJPY || 0));
}

function tierIndex(tiers, id) {
  return tiers.findIndex((t) => String(t.id) === String(id));
}

function findTierForBalance(tiers, balance) {
  const b = Number(balance || 0);
  return tiers.find((t) => {
    const min = Number(t.minBalanceJPY || 0);
    const max = t.maxBalanceJPY === null || t.maxBalanceJPY === undefined
      ? Number.POSITIVE_INFINITY
      : Number(t.maxBalanceJPY);
    return b >= min && b <= max;
  }) || tiers[0] || null;
}

function summarizeRolling(trades, lookback = 30) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => String(t?.exitReason || "").startsWith("auto-"))
    .slice(-Math.max(1, Number(lookback || 30)));
  const grossProfit = list.filter((t) => Number(t.netPnlJpy || 0) > 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0);
  const grossLoss = Math.abs(list.filter((t) => Number(t.netPnlJpy || 0) < 0).reduce((s, t) => s + Number(t.netPnlJpy || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 1);
  const expectancyJpy = list.length ? list.reduce((s, t) => s + Number(t.netPnlJpy || 0), 0) / list.length : 0;
  return {
    sampleSize: list.length,
    profitFactor: Number(profitFactor.toFixed(4)),
    expectancyJpy: Number(expectancyJpy.toFixed(2)),
    expectancyPositive: expectancyJpy > 0
  };
}

function countTodayFullTrades(trades, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return (Array.isArray(trades) ? trades : []).filter((t) => {
    const mode = String(t.tradeMode || "").toUpperCase();
    if (!(mode === "FULL" || mode === "AGGRESSIVE")) return false;
    const tt = new Date(t.entryTime || t.exitTime || 0);
    return tt.getFullYear() === y && tt.getMonth() === m && tt.getDate() === d;
  }).length;
}

export function evaluateCapitalScaling({
  state = {},
  currentBalanceJPY,
  cfg = {},
  rolling = {},
  executionStress = false,
  noDrawdownWarning = true,
  noConsecutiveLossWarning = true,
  dailyLossWarning = false,
  now = new Date()
} = {}) {
  if (!cfg?.enabled) {
    return {
      enabled: false,
      runtime: state.capitalScalingRuntime || {},
      diagnostics: { enabled: false },
      settingsOverride: {},
      events: []
    };
  }

  const tiers = sortedTiers(cfg);
  const balance = Number(currentBalanceJPY || 0);
  const candidateTier = findTierForBalance(tiers, balance);
  const prevRuntime = state.capitalScalingRuntime || {};
  const fallbackTier = candidateTier || tiers[0] || null;
  let activeTier = tiers.find((t) => String(t.id) === String(prevRuntime.activeTierId || "")) || fallbackTier;
  const previousTierId = String(prevRuntime.activeTierId || activeTier?.id || "");
  const candidateTierId = String(candidateTier?.id || "");
  const activeIdx = tierIndex(tiers, activeTier?.id);
  const candidateIdx = tierIndex(tiers, candidateTier?.id);
  const reachedAt = String(prevRuntime.candidateTierId || "") === candidateTierId
    ? (prevRuntime.candidateTierReachedAt || now.toISOString())
    : now.toISOString();
  const allAutoTrades = (Array.isArray(state.trades) ? state.trades : []).filter((t) => String(t?.exitReason || "").startsWith("auto-"));
  const reachedMs = new Date(reachedAt).getTime();
  const tradesSinceCandidateTierReached = allAutoTrades.filter((t) => {
    const tMs = new Date(t.entryTime || t.exitTime || 0).getTime();
    return Number.isFinite(tMs) && tMs >= reachedMs;
  }).length;
  const roll = rolling.sampleSize !== undefined ? rolling : summarizeRolling(state.trades, 30);
  const events = [];
  const promotionBlockedReasons = [];
  const demotionReasons = [];
  const promotionRules = cfg.promotionRules || {};
  const demotionRules = cfg.demotionRules || {};

  if (candidateTierId && candidateTierId !== String(prevRuntime.candidateTierId || "")) {
    events.push({ event: "tier_candidate_reached", candidateTierId });
  }

  const demoteByBalance = Boolean(demotionRules.demoteImmediatelyIfBalanceFallsBelowTier ?? true)
    && activeTier
    && balance < Number(activeTier.minBalanceJPY || 0);
  if (demoteByBalance) demotionReasons.push("balance_below_active_tier");
  if (Boolean(demotionRules.demoteOnDrawdownWarning) && !noDrawdownWarning) demotionReasons.push("drawdown_warning");
  if (Boolean(demotionRules.demoteOnDailyLossWarning) && dailyLossWarning) demotionReasons.push("daily_loss_warning");
  if (Number(state?.account?.consecutiveLosses || 0) >= Number(demotionRules.demoteOnConsecutiveLosses || 99)) demotionReasons.push("consecutive_loss_warning");
  if (Boolean(demotionRules.demoteOnExecutionStress) && executionStress) demotionReasons.push("execution_stress");
  if (Boolean(demotionRules.demoteOnRollingExpectancyNegative) && Number(roll.expectancyJpy || 0) < 0) demotionReasons.push("rolling_expectancy_negative");

  let demotionTriggered = demotionReasons.length > 0 && candidateIdx >= 0 && activeIdx > candidateIdx;
  if (demotionTriggered) {
    activeTier = candidateTier;
    events.push({ event: "tier_demoted", activeTierId: activeTier?.id, reasons: demotionReasons });
  }

  let promotionEligible = false;
  if (!demotionTriggered && candidateIdx > activeIdx) {
    if (tradesSinceCandidateTierReached < Number(promotionRules.requireBalanceAboveTierForTrades || 30)) {
      promotionBlockedReasons.push("confirm_trades_pending");
    }
    if (Number(roll.profitFactor || 0) < Number(promotionRules.requireRollingPFMin || 1.1)) {
      promotionBlockedReasons.push("rolling_pf_low");
    }
    if (Boolean(promotionRules.requireRollingExpectancyPositive) && !Boolean(roll.expectancyPositive)) {
      promotionBlockedReasons.push("rolling_expectancy_not_positive");
    }
    if (Boolean(promotionRules.requireNoDrawdownWarning) && !noDrawdownWarning) {
      promotionBlockedReasons.push("drawdown_warning");
    }
    if (Boolean(promotionRules.requireNoExecutionStress) && executionStress) {
      promotionBlockedReasons.push("execution_stress");
    }
    if (Boolean(promotionRules.requireNoConsecutiveLossWarning) && !noConsecutiveLossWarning) {
      promotionBlockedReasons.push("consecutive_loss_warning");
    }
    promotionEligible = promotionBlockedReasons.length === 0;
    if (promotionEligible) {
      activeTier = candidateTier;
      events.push({ event: "tier_promoted", activeTierId: activeTier?.id });
    } else {
      if (promotionBlockedReasons.includes("drawdown_warning")) events.push({ event: "scaling_blocked_by_drawdown" });
      if (promotionBlockedReasons.includes("execution_stress")) events.push({ event: "scaling_blocked_by_execution_stress" });
      if (promotionBlockedReasons.includes("rolling_pf_low")) events.push({ event: "scaling_blocked_by_low_pf" });
    }
  }

  const fullRules = cfg.fullUnlockRules || {};
  const fullNormal = balance >= Number(fullRules.normalFullMinBalanceJPY || 100000)
    && Number(roll.profitFactor || 0) >= Number(fullRules.rollingPFMin || 1.2)
    && (!Boolean(fullRules.requireRollingExpectancyPositive) || Boolean(roll.expectancyPositive))
    && noDrawdownWarning
    && !executionStress;
  const fullTrial = !fullNormal
    && balance >= Number(fullRules.trialFullMinBalanceJPY || 50000)
    && Boolean(activeTier?.fullTrialEnabled)
    && countTodayFullTrades(state.trades, now) < Number(activeTier?.fullTrialMaxTradesPerDay ?? fullRules.trialFullMaxTradesPerDay ?? 2);
  if (fullNormal) events.push({ event: "full_normal_unlocked" });
  else if (fullTrial) events.push({ event: "full_trial_unlocked" });

  const allowedModes = Array.isArray(activeTier?.allowedModes) ? activeTier.allowedModes.map((m) => String(m).toUpperCase()) : ["BASE"];
  if (fullTrial && !allowedModes.includes("FULL")) allowedModes.push("FULL");
  const settingsOverride = {
    riskPercentPerTrade: Number(activeTier?.riskPercentPerTrade ?? 1),
    maxRiskPercentPerTrade: Number(activeTier?.maxRiskPercentPerTrade ?? activeTier?.riskPercentPerTrade ?? 1),
    maxEffectiveLeverage: Math.min(25, Number(activeTier?.maxEffectiveLeverage ?? 10)),
    allowedModes,
    fullTrialRiskMultiplier: fullTrial ? Number(activeTier?.fullTrialRiskMultiplier ?? fullRules.trialFullRiskMultiplier ?? 0.5) : 1
  };

  const runtime = {
    activeTierId: String(activeTier?.id || ""),
    candidateTierId,
    previousTierId,
    tierChangedAt: activeTier?.id !== previousTierId ? now.toISOString() : (prevRuntime.tierChangedAt || now.toISOString()),
    candidateTierReachedAt: reachedAt,
    tradesSinceCandidateTierReached,
    promotionEligible,
    promotionBlockedReasons,
    demotionTriggered,
    demotionReasons,
    lastScalingDecisionAt: now.toISOString(),
    lastScalingReason: events.length ? events.map((e) => e.event).join(",") : "tier maintained"
  };

  return {
    enabled: true,
    runtime,
    activeTier,
    candidateTier,
    settingsOverride,
    events,
    diagnostics: {
      enabled: true,
      currentBalanceJPY: balance,
      activeTierId: runtime.activeTierId,
      activeTierLabel: activeTier?.label || runtime.activeTierId,
      candidateTierId,
      candidateTierLabel: candidateTier?.label || candidateTierId,
      riskPercentPerTrade: settingsOverride.riskPercentPerTrade,
      maxRiskPercentPerTrade: settingsOverride.maxRiskPercentPerTrade,
      maxEffectiveLeverage: settingsOverride.maxEffectiveLeverage,
      allowedModes,
      promotionEligible,
      promotionBlockedReasons,
      demotionTriggered,
      demotionReasons,
      scalingReason: runtime.lastScalingReason,
      fullUnlockStatus: fullNormal ? "NORMAL" : (fullTrial ? "TRIAL" : "LOCKED"),
      fullTrialApplied: fullTrial,
      tradesSinceCandidateTierReached,
      promotionRequiredTrades: Number(promotionRules.requireBalanceAboveTierForTrades || 30),
      rollingPF: Number(roll.profitFactor || 0),
      rollingExpectancyPositive: Boolean(roll.expectancyPositive),
      noDrawdownWarning,
      noExecutionStress: !executionStress,
      noConsecutiveLossWarning
    }
  };
}
