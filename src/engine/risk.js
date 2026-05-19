export function evaluateRiskGate({ account, signal, config }) {
  const dailyLossRatio = account.dayPnlJpy < 0 ? Math.abs(account.dayPnlJpy) / account.currentBalanceJpy : 0;
  if (dailyLossRatio >= config.risk.dailyStopPercent) {
    return {
      allowed: false,
      reason: "Daily stop reached",
      positionSize: 0
    };
  }

  if (signal.action === "HOLD") {
    return {
      allowed: false,
      reason: "No trade signal",
      positionSize: 0
    };
  }

  const weeklyDrawdownRatio = account.weekDrawdownJpy > 0 ? account.weekDrawdownJpy / account.currentBalanceJpy : 0;
  if (weeklyDrawdownRatio >= config.risk.weeklyDrawdownPercent) {
    return {
      allowed: false,
      reason: "Weekly drawdown limit reached",
      positionSize: 0
    };
  }

  const lossScale = resolveLossScale(account.consecutiveLosses, config.risk.consecutiveLossScale);
  const effectiveLossScale = Math.max(0.15, Number(lossScale || 0));
  const lossThrottled = effectiveLossScale < 0.99;

  const userRiskPercent = Math.round(clamp(
    Number(account.maxRiskPercentPerTrade ?? config.risk.riskPerTrade * 100),
    1,
    100
  ));
  const userRiskFraction = clamp(userRiskPercent / 100, 0.001, config.risk.riskPerTradeMax);
  const learningRiskMultiplier = clamp(Number(account.learningRiskMultiplier ?? 1), 0.3, 1.3);
  const riskFraction = clamp(userRiskFraction * learningRiskMultiplier, 0.001, config.risk.riskPerTradeMax);
  const riskBudget = account.currentBalanceJpy * riskFraction * effectiveLossScale;
  const stopDistance = Math.abs(signal.entryPrice - signal.stopLossPrice);
  if (stopDistance <= 0) {
    return {
      allowed: false,
      reason: "Invalid stop distance",
      positionSize: 0
    };
  }

  const riskBasedSize = riskBudget / stopDistance;
  const maxNotionalJpy = account.currentBalanceJpy * (userRiskPercent / 100);
  const sizeByNotional = signal.entryPrice > 0 ? (maxNotionalJpy / signal.entryPrice) : 0;
  const positionSize = Math.max(0, Math.min(riskBasedSize, sizeByNotional));

  return {
    allowed: positionSize > 0,
    reason: positionSize > 0
      ? (lossThrottled ? "Consecutive loss throttle" : "OK")
      : "Position size reduced to zero by risk limit",
    positionSize,
    riskBudget,
    maxNotionalJpy,
    lossScale: effectiveLossScale,
    riskFraction
  };
}

function resolveLossScale(consecutiveLosses, rules) {
  if (consecutiveLosses >= 4) return rules[4];
  if (consecutiveLosses >= 3) return rules[3];
  if (consecutiveLosses >= 2) return rules[2];
  return 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
