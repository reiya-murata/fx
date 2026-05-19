import { atr } from "./indicators.js";
import { Regime } from "./regime.js";
import { evaluateTrendEngine } from "./trendEngine.js";
import { evaluateRangeEngine } from "./rangeEngine.js";

function buildTradeLevels(price, direction, atrValue, config, profile = {}) {
  const stopMul = Number(profile.stopAtrMultiplier || config.exit.stopAtrMultiplier);
  const tpMul = Number(profile.tpAtrMultiplier || config.exit.tpAtrMultiplier);
  const stopDistance = Math.max(atrValue * stopMul, config.pipSize * 2);
  const takeDistance = atrValue * tpMul;

  if (direction === "BUY") {
    return {
      entryPrice: price,
      stopLossPrice: price - stopDistance,
      takeProfitPrice: price + takeDistance
    };
  }

  return {
    entryPrice: price,
    stopLossPrice: price + stopDistance,
    takeProfitPrice: price - takeDistance
  };
}

function expectedValuePips(levels, direction, pipSize, winRateGuess = 0.48) {
  const gain = direction === "BUY"
    ? (levels.takeProfitPrice - levels.entryPrice) / pipSize
    : (levels.entryPrice - levels.takeProfitPrice) / pipSize;
  const loss = direction === "BUY"
    ? (levels.entryPrice - levels.stopLossPrice) / pipSize
    : (levels.stopLossPrice - levels.entryPrice) / pipSize;
  return winRateGuess * gain - (1 - winRateGuess) * loss;
}

function estimateRoundTripCostPips(levels, spreadPips, config) {
  const spreadCost = Number(spreadPips || 0);
  const slippageCost = Number(config.execution?.maxSlippagePips || 0) * 0.35;
  const entry = Number(levels.entryPrice || 0);
  const feeBps = Number(config.execution?.feeBps || 0);
  const feeOneSidePrice = (entry * feeBps) / 10000;
  const feeRoundPips = config.pipSize > 0 ? (feeOneSidePrice * 2) / config.pipSize : 0;
  return spreadCost + slippageCost + feeRoundPips;
}

function riskReward(levels, direction, pipSize) {
  const reward = direction === "BUY"
    ? (levels.takeProfitPrice - levels.entryPrice) / pipSize
    : (levels.entryPrice - levels.takeProfitPrice) / pipSize;
  const risk = direction === "BUY"
    ? (levels.entryPrice - levels.stopLossPrice) / pipSize
    : (levels.stopLossPrice - levels.entryPrice) / pipSize;
  if (risk <= 0) return 0;
  return reward / risk;
}

export function generateSignal({
  regime,
  candles1m,
  bid,
  ask,
  spreadPips,
  orderBookImbalance = 0,
  marketFeatures = null,
  config,
  directionBias = "NEUTRAL",
  confidenceDelta = 0,
  learnedContext = null
}) {
  const last = candles1m[candles1m.length - 1];
  const atrValue = atr(candles1m, config.volatility.atrPeriod);
  const bidPrice = Number(bid);
  const askPrice = Number(ask);
  const derivedSpreadPips = Number.isFinite(bidPrice) && Number.isFinite(askPrice) && askPrice > bidPrice && Number(config.pipSize) > 0
    ? (askPrice - bidPrice) / config.pipSize
    : null;
  const effectiveSpreadPips = Number.isFinite(Number(spreadPips)) && Number(spreadPips) >= 0
    ? Number(spreadPips)
    : Number(derivedSpreadPips || 0);
  const normalSpreadGatePips = Number(config.spread?.maxPipsNormal || 0.3);
  const hardSpreadGatePips = Math.max(
    normalSpreadGatePips * 2.5,
    Number(config.spread?.highVolatilityPips || normalSpreadGatePips),
    0.6
  );
  let highSpreadWarning = false;
  let highSpreadReason = null;
  let highVolScalp = false;

  if (!last || atrValue <= 0) {
    return holdSignal("Insufficient data");
  }

  if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice) || bidPrice <= 0 || askPrice <= 0 || askPrice <= bidPrice) {
    return holdSignal("Invalid realtime bid/ask");
  }

  if (effectiveSpreadPips > hardSpreadGatePips) {
    return holdSignal(`Spread too wide (${effectiveSpreadPips.toFixed(3)} > ${hardSpreadGatePips.toFixed(3)})`);
  }

  if (effectiveSpreadPips > normalSpreadGatePips) {
    highSpreadWarning = true;
    highSpreadReason = `spread warning (${effectiveSpreadPips.toFixed(3)} > ${normalSpreadGatePips.toFixed(3)}), evaluated as cost penalty`;
  }

  let action = "HOLD";
  let levels;
  let rationale = "No setup";
  let extraMetrics = null;
  const regimeProfile = config.regimeProfiles?.[regime] || {};
  const regimeMinRr = Number(config.executionGate.minRiskReward || 1) + Number(regimeProfile.minRiskRewardDelta || 0);
  const regimeMinEv = Number(config.executionGate.minExpectedValuePips || 0) + Number(regimeProfile.minExpectedValueDelta || 0);
  const regimeConfidenceDelta = Number(regimeProfile.confidenceDelta || 0);

  if (regime === Regime.TREND_UP || regime === Regime.TREND_DOWN) {
    const out = evaluateTrendEngine({
      regime,
      ask,
      bid,
      atrValue,
      marketFeatures,
      config,
      regimeProfile: config.regimeProfiles?.[regime] || {}
    });
    if (out.action === "HOLD") return holdSignal(out.rationale, out.diagnostics || null);
    action = out.action;
    levels = out.levels;
    rationale = out.rationale;
  }

  if (regime === Regime.RANGE) {
    const out = evaluateRangeEngine({
      regime,
      candles1m,
      ask,
      bid,
      atrValue,
      spreadPips: effectiveSpreadPips,
      marketFeatures,
      config,
      regimeProfile: config.regimeProfiles?.[regime] || {}
    });
    if (out.action === "HOLD") return holdSignal(out.rationale, out.diagnostics || null);
    action = out.action;
    levels = out.levels;
    rationale = out.rationale;
    if (out.metrics) extraMetrics = out.metrics;
  }

  if (regime === Regime.HIGH_VOLATILITY) {
    // In high volatility, do not freeze forever: allow only strong short-term momentum with tighter risk.
    if (effectiveSpreadPips > config.spread.highVolatilityPips * 1.25) {
      return holdSignal(`High volatility spread safeguard (${effectiveSpreadPips.toFixed(3)}pips)`);
    }
    const recent = candles1m.slice(-4);
    if (recent.length < 4) {
      return holdSignal("High volatility: insufficient momentum data");
    }
    const momentumPips = (Number(recent[recent.length - 1].close) - Number(recent[0].close)) / config.pipSize;
    if (Math.abs(momentumPips) < 1.2) {
      return holdSignal("High volatility: no momentum edge");
    }
    action = momentumPips >= 0 ? "BUY" : "SELL";
    const ref = action === "BUY" ? ask : bid;
    const stopMul = Number((config.regimeProfiles?.[regime]?.stopAtrMultiplier) || config.exit.stopAtrMultiplier * 0.85);
    const tpMul = Number((config.regimeProfiles?.[regime]?.tpAtrMultiplier) || config.exit.tpAtrMultiplier * 0.9);
    const stopDistance = Math.max(atrValue * stopMul, config.pipSize * 2);
    const takeDistance = Math.max(atrValue * tpMul, config.pipSize * 2.4);
    levels = action === "BUY"
      ? {
        entryPrice: ref,
        stopLossPrice: ref - stopDistance,
        takeProfitPrice: ref + takeDistance
      }
      : {
        entryPrice: ref,
        stopLossPrice: ref + stopDistance,
        takeProfitPrice: ref - takeDistance
      };
    rationale = "High-volatility momentum scalp";
    highVolScalp = true;
  }

  if (action === "HOLD" || !levels) {
    return holdSignal(rationale);
  }

  if (directionBias === "BUY" && action === "SELL") {
    return holdSignal("Blocked by bullish macro-news bias");
  }
  if (directionBias === "SELL" && action === "BUY") {
    return holdSignal("Blocked by bearish macro-news bias");
  }
  if (marketFeatures?.ready) {
    const rsiV = Number(marketFeatures.rsi1m);
    const bbZ = Math.abs(Number(marketFeatures.bbZ1m || 0));
    const eco = Number(marketFeatures.economicPressure || 0);
    const overheating = bbZ >= 6.5 || eco >= 0.95;
    if (overheating && action === "BUY" && rsiV >= 99) return holdSignal("RSI過熱で買い見送り");
    if (overheating && action === "SELL" && rsiV <= 1) return holdSignal("RSI過熱で売り見送り");
  }
  if (action === "BUY" && Number(orderBookImbalance) < -0.55) {
    return holdSignal("Blocked by sell-side orderbook imbalance");
  }
  if (action === "SELL" && Number(orderBookImbalance) > 0.55) {
    return holdSignal("Blocked by buy-side orderbook imbalance");
  }

  const rr = riskReward(levels, action, config.pipSize);
  const evRaw = expectedValuePips(levels, action, config.pipSize);
  const costPips = estimateRoundTripCostPips(levels, effectiveSpreadPips, config);
  const trendBonus = clamp(Number(marketFeatures?.momentumScore || 0) * 0.12, -0.12, 0.12);
  const learnedSignal = buildLearnedSignalScore({ evRaw, rr, marketFeatures, learnedContext });
  const ev = evRaw - costPips + trendBonus + learnedSignal.evDelta;

  if (rr < regimeMinRr && rr < 0.7) {
    return holdSignal("Risk/reward below threshold");
  }

  if (ev < regimeMinEv && ev < -1.0) {
    return holdSignal("Expected value below threshold (after cost)");
  }

  const imbalanceBonus = clamp(Number(orderBookImbalance || 0) * (action === "BUY" ? 0.06 : -0.06), -0.07, 0.07);
  const featureBonus = clamp(Number(marketFeatures?.momentumScore || 0) * 0.06 - Number(marketFeatures?.economicPressure || 0) * 0.05, -0.08, 0.08);
  const highVolPenalty = highVolScalp ? 0.07 : 0;
  const confidence = Math.min(0.95, Math.max(
    0.2,
    0.45 + ev / 10 + (rr - 1) * 0.1 + confidenceDelta + regimeConfidenceDelta + learnedSignal.confidenceDelta + imbalanceBonus + featureBonus - highVolPenalty
  ));
  return {
    action,
    confidence,
    rationale,
    ...levels,
    regime,
    metrics: {
      ...(extraMetrics || {}),
      rr,
      expectedValueRawPips: evRaw,
      expectedValuePips: ev,
      estimatedCostPips: costPips,
      spreadPips: effectiveSpreadPips,
      rawSpreadPips: Number.isFinite(Number(spreadPips)) ? Number(spreadPips) : null,
      derivedSpreadPips,
      normalSpreadGatePips,
      hardSpreadGatePips,
      highSpreadWarning,
      highSpreadReason,
      orderBookImbalance: Number(orderBookImbalance || 0),
      rsi1m: Number(marketFeatures?.rsi1m ?? 0),
      macdHist1m: Number(marketFeatures?.macdHist1m ?? 0),
      bbZ1m: Number(marketFeatures?.bbZ1m ?? 0),
      atrPips1m: Number(marketFeatures?.atrPips1m ?? 0),
      trendSlope15mPips: Number(marketFeatures?.trendSlope15mPips ?? 0),
      economicPressure: Number(marketFeatures?.economicPressure ?? 0),
      learnedScore: Number(learnedSignal.score.toFixed(4))
    }
  };
}

function holdSignal(reason, extraMetrics = null) {
  return {
    action: "HOLD",
    confidence: 0.3,
    rationale: reason,
    entryPrice: null,
    stopLossPrice: null,
    takeProfitPrice: null,
    metrics: extraMetrics
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildLearnedSignalScore({ evRaw, rr, marketFeatures, learnedContext }) {
  const w = learnedContext?.weights || {};
  if (!learnedContext?.ready) {
    return { score: 0, confidenceDelta: 0, evDelta: 0 };
  }
  const evNorm = clamp(Number(evRaw || 0) / 2.5, -1, 1);
  const rrNorm = clamp((Number(rr || 1) - 1) / 1.2, -1, 1);
  const momNorm = clamp(Number(marketFeatures?.momentumScore || 0), -1, 1);
  const score = clamp(
    evNorm * Number(w.ev || 0)
      + rrNorm * Number(w.rr || 0)
      + momNorm * Number(w.momentum || 0),
    -1,
    1
  );
  return {
    score,
    confidenceDelta: clamp(score * 0.05, -0.05, 0.05),
    evDelta: clamp(score * 0.08, -0.12, 0.12)
  };
}
