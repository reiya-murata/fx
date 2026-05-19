import { DEFAULT_CONFIG } from "../config/defaults.js";
import { detectRegime, smoothRegime } from "./regime.js";
import { evaluateRiskGate } from "./risk.js";
import { generateSignal } from "./strategy.js";
import { computeAdaptiveTuning } from "../services/adaptive.js";
import { buildNewsContext } from "../services/news.js";
import { computeUsdJpySessionTendency } from "../services/sessionTendency.js";
import { computeWalkForwardTuning } from "../services/walkForward.js";
import { buildMarketFeatureContext } from "../services/marketFeatures.js";
import { buildLearnedContext } from "../services/learnedModel.js";

export function buildAssistantDecision(input, config = DEFAULT_CONFIG) {
  const adaptive = input.enableSelfLearning
    ? computeAdaptiveTuning(input.trades || [], {
      lookback: 200,
      ewmaAlpha: config.adaptive.ewmaAlpha,
      minSampleSize: config.adaptive.minSampleSize,
      maxRiskStepPerCycle: config.adaptive.maxRiskStepPerCycle,
      shadowMode: Boolean(input.shadowLearningMode ?? config.adaptive.shadowMode)
    })
    : computeAdaptiveTuning([]);
  const news = input.enableNewsFilter
    ? buildNewsContext(input.newsEvents || [], {
      preEventBlockMinutes: input.preEventBlockMinutes ?? config.news.preEventBlockMinutes,
      postEventBlockMinutes: input.postEventBlockMinutes ?? config.news.postEventBlockMinutes
    })
    : buildNewsContext([]);
  const sessionTendency = computeUsdJpySessionTendency(input.trades || []);
  const marketFeatures = {
    ...buildMarketFeatureContext({
      candles1m: input.candles1m,
      candles5m: input.candles5m,
      candles15m: input.candles15m,
      pipSize: config.pipSize,
      news
    }),
    ...(input.marketFeatures || {})
  };
  const walkForward = input.enableWalkForward
    ? computeWalkForwardTuning(input.trades || [], { lookback: 240, minSample: 60 })
    : { apply: false, minRiskRewardDelta: 0, minExpectedValueDelta: 0, confidenceDelta: 0 };
  const learned = buildLearnedContext(input.learnedStats);
  const effectiveConfig = buildEffectiveConfig(
    config,
    adaptive,
    news,
    sessionTendency,
    walkForward,
    learned,
    marketFeatures,
    Boolean(input.blockHighImpactNews)
  );

  const baseRegime = detectRegime({
    candles1m: input.candles1m,
    candles5m: input.candles5m,
    candles15m: input.candles15m,
    spreadPips: input.spreadPips,
    config: effectiveConfig
  });
  const regime = smoothRegime(baseRegime, input.trades || [], effectiveConfig);

  const signal = generateSignal({
    regime,
    candles1m: input.candles1m,
    bid: input.bid,
    ask: input.ask,
    spreadPips: input.spreadPips,
    orderBookImbalance: input.orderBookImbalance,
    marketFeatures,
    config: effectiveConfig,
    directionBias: resolveDirectionBias(news.directionBias, sessionTendency.directionBias),
    confidenceDelta:
      adaptive.confidenceDelta
      + sessionTendency.confidenceDelta
      + marketFeatures.confidenceDelta
      + (walkForward.apply ? walkForward.confidenceDelta : 0)
      + (learned.ready ? learned.confidenceDelta : 0),
    learnedContext: learned
  });

  const blockOnShortTermRiskLock = Boolean(config?.news?.blockOnShortTermRiskLock ?? false);
  if (input.blockHighImpactNews && (news.tradingBlocked || (blockOnShortTermRiskLock && news.shortTermRiskLock))) {
    return blockedDecision(regime, signal, "High-impact news risk lock", adaptive, news, marketFeatures);
  }

  const risk = evaluateRiskGate({
    account: {
      ...input.account,
      maxRiskPercentPerTrade: input.maxRiskPercentPerTrade,
      learningRiskMultiplier: adaptive.riskMultiplier
    },
    signal,
    config: effectiveConfig
  });

  if (!risk.allowed) {
    return blockedDecision(regime, signal, risk.reason, adaptive, news, marketFeatures);
  }

  const entryQuality = evaluateEntryQualityGuard({
    regime,
    signal,
    marketFeatures,
    config: effectiveConfig
  });

  if (entryQuality.blocked) {
    return blockedDecision(
      regime,
      {
        ...signal,
        rationale: `${signal.rationale}; entry-quality: ${entryQuality.reason}`,
        metrics: {
          ...(signal.metrics || {}),
          entryQualityGuard: entryQuality
        }
      },
      entryQuality.reason,
      adaptive,
      news,
      marketFeatures
    );
  }

  return {
    action: signal.action,
    confidence: signal.confidence,
    rationale: signal.rationale,
    regime,
    safetyFlags: [],
    entryPrice: signal.entryPrice,
    stopLossPrice: signal.stopLossPrice,
    takeProfitPrice: signal.takeProfitPrice,
    positionSize: risk.positionSize,
    metrics: {
      ...(signal.metrics || {}),
      riskFraction: risk.riskFraction,
      entryQualityGuard: entryQuality
    },
    adaptive,
    marketFeatures,
    sessionTendency,
    walkForward,
    learned,
    news
  };
}

function blockedDecision(regime, signal, reason, adaptive, news, marketFeatures) {
  return {
    action: "HOLD",
    confidence: signal.confidence,
    rationale: `${signal.rationale}; blocked: ${reason}`,
    regime,
    safetyFlags: [reason],
    entryPrice: null,
    stopLossPrice: null,
    takeProfitPrice: null,
    positionSize: 0,
    metrics: signal.metrics || {},
    adaptive,
    marketFeatures,
    news
  };
}

function buildEffectiveConfig(config, adaptive, news, sessionTendency, walkForward, learned, marketFeatures, blockHighImpactNews) {
  const shortTermRiskPenalty = clamp(Number(news.shortTermRiskLevel || 0), 0, 1);
  const marketPenalty = clamp(Number(marketFeatures?.economicPressure || 0), 0, 1);
  const minRiskReward = clamp(
    config.executionGate.minRiskReward
      + adaptive.minRiskRewardDelta
      + shortTermRiskPenalty * 0.25
      + marketPenalty * 0.15
      + (walkForward.apply ? walkForward.minRiskRewardDelta : 0)
      + (learned?.ready ? Number(learned.minRiskRewardDelta || 0) : 0),
    0.9,
    2.4
  );
  const minExpectedValuePips = clamp(
    config.executionGate.minExpectedValuePips
      + adaptive.minExpectedValueDelta
      + (walkForward.apply ? walkForward.minExpectedValueDelta : 0)
      + (learned?.ready ? Number(learned.minExpectedValueDelta || 0) : 0)
      + Math.abs(news.score) * 0.03
      + shortTermRiskPenalty * 0.06,
    -0.15,
    0.6
  );

  const highImpactSpreadTightening = blockHighImpactNews && news.highImpactEvent ? 0.85 : 1;
  const politicalSpreadTightening = 1 - shortTermRiskPenalty * 0.2;
  const spreadMax = clamp(config.spread.maxPipsNormal * highImpactSpreadTightening, 0.12, config.spread.maxPipsNormal);

  return {
    ...config,
    spread: {
      ...config.spread,
      maxPipsNormal: clamp(spreadMax * politicalSpreadTightening, 0.1, config.spread.maxPipsNormal)
    },
    executionGate: {
      ...config.executionGate,
      minRiskReward,
      minExpectedValuePips
    }
  };

}

function evaluateEntryQualityGuard({ regime, signal, marketFeatures, config }) {
  const metrics = signal.metrics || {};
  const action = signal.action;
  const rationale = String(signal.rationale || "");
  const isTrendUpBuy = regime === "TREND_UP" && action === "BUY";
  const isPullbackReAcceleration = /pullback re-acceleration|押し目|再加速/i.test(rationale);

  if (!isTrendUpBuy || !isPullbackReAcceleration) {
    return {
      blocked: false,
      reason: null,
      category: "not_trend_up_pullback_buy",
      entryLocationCategory: metrics.entryLocationCategory || null,
      quickAdverseRisk: 0
    };
  }

  const rsi1m = firstFinite(metrics.rsi1m, metrics.rsi, marketFeatures?.rsi1m);
  const bbZ1m = firstFinite(metrics.bbZ1m, metrics.bbZ, marketFeatures?.bbZ1m);
  const rsi5m = firstFinite(metrics.rsi5m, marketFeatures?.rsi5m);
  const rsi10m = firstFinite(metrics.rsi10m, marketFeatures?.rsi10m);
  const bbZ5m = firstFinite(metrics.bbZ5m, marketFeatures?.bbZ5m);
  const bbZ10m = firstFinite(metrics.bbZ10m, marketFeatures?.bbZ10m);
  const momentum5mPips = firstFinite(metrics.momentum5mPips, marketFeatures?.momentum5mPips);
  const momentum10mPips = firstFinite(metrics.momentum10mPips, marketFeatures?.momentum10mPips);
  const shortTermAlignmentScore = firstFinite(metrics.shortTermAlignmentScore, marketFeatures?.shortTermAlignmentScore);
  const shortTermExhaustionScore = firstFinite(metrics.shortTermExhaustionScore, marketFeatures?.shortTermExhaustionScore);
  const entryLocationCategory = metrics.entryLocationCategory || metrics.trendUpEntryQuality || metrics.entryQualityCategory || null;
  const entryLocationScore = firstFinite(metrics.entryLocationScore, metrics.entryEvidenceScore);
  const multiTimeframeScore = firstFinite(metrics.multiTimeframeScore, marketFeatures?.multiTimeframeScore);

  const hasEntryQualityContext = Boolean(entryLocationCategory)
    || isFiniteNumber(entryLocationScore)
    || isFiniteNumber(multiTimeframeScore)
    || isFiniteNumber(shortTermAlignmentScore)
    || isFiniteNumber(shortTermExhaustionScore);

  if (!hasEntryQualityContext) {
    return {
      blocked: false,
      reason: null,
      category: "trend_up_pullback_quality_insufficient_context",
      entryLocationCategory: null,
      entryLocationScore: null,
      multiTimeframeScore: null,
      shortTermAlignmentScore: null,
      shortTermExhaustionScore: null,
      quickAdverseRisk: 0,
      reasons: [],
      warnings: []
    };
  }

  const reasons = [];
  const warnings = [];

  if (entryLocationCategory === "noPullbackEntry") {
    reasons.push("no pullback confirmation");
  }

  if (entryLocationCategory === "validPullbackEntry" && isFiniteNumber(entryLocationScore) && entryLocationScore < 0.72) {
    reasons.push(`weak pullback location score (${entryLocationScore.toFixed(3)} < 0.720)`);
  }

  if (isFiniteNumber(shortTermAlignmentScore) && shortTermAlignmentScore < 0.55) {
    reasons.push(`short-term alignment too weak (${shortTermAlignmentScore.toFixed(3)} < 0.550)`);
  } else if (isFiniteNumber(shortTermAlignmentScore) && shortTermAlignmentScore < 0.65) {
    warnings.push(`short-term alignment weak (${shortTermAlignmentScore.toFixed(3)} < 0.650)`);
  }

  if (isFiniteNumber(multiTimeframeScore) && multiTimeframeScore < 0.50) {
    reasons.push(`multi-timeframe score too weak (${multiTimeframeScore.toFixed(3)} < 0.500)`);
  } else if (isFiniteNumber(multiTimeframeScore) && multiTimeframeScore < 0.60) {
    warnings.push(`multi-timeframe score weak (${multiTimeframeScore.toFixed(3)} < 0.600)`);
  }

  if (isFiniteNumber(shortTermExhaustionScore) && shortTermExhaustionScore < 0.45) {
    reasons.push(`short-term exhaustion risk (${shortTermExhaustionScore.toFixed(3)} < 0.450)`);
  }

  if (isFiniteNumber(rsi1m) && rsi1m >= 80) {
    reasons.push(`rsi1m overextended (${rsi1m.toFixed(1)} >= 80.0)`);
  } else if (isFiniteNumber(rsi1m) && rsi1m >= 75 && isFiniteNumber(bbZ1m) && bbZ1m >= 1.0) {
    reasons.push(`1m overextended buy (${rsi1m.toFixed(1)} RSI, ${bbZ1m.toFixed(2)} bbZ)`);
  } else if (isFiniteNumber(rsi1m) && rsi1m >= 70 && isFiniteNumber(bbZ1m) && bbZ1m >= 1.2) {
    reasons.push(`1m late buy risk (${rsi1m.toFixed(1)} RSI, ${bbZ1m.toFixed(2)} bbZ)`);
  }

  if (isFiniteNumber(rsi5m) && rsi5m >= 74) {
    reasons.push(`rsi5m overextended (${rsi5m.toFixed(1)} >= 74.0)`);
  }

  if (isFiniteNumber(rsi10m) && rsi10m >= 74) {
    reasons.push(`rsi10m overextended (${rsi10m.toFixed(1)} >= 74.0)`);
  }

  if (isFiniteNumber(bbZ5m) && bbZ5m >= 1.25) {
    reasons.push(`bbZ5m overextended (${bbZ5m.toFixed(2)} >= 1.25)`);
  }

  if (isFiniteNumber(bbZ10m) && bbZ10m >= 1.25) {
    reasons.push(`bbZ10m overextended (${bbZ10m.toFixed(2)} >= 1.25)`);
  }

  if (isFiniteNumber(momentum5mPips) && isFiniteNumber(momentum10mPips) && momentum5mPips > 0 && momentum10mPips < 0) {
    reasons.push(`5m/10m momentum mismatch (${momentum5mPips.toFixed(2)} / ${momentum10mPips.toFixed(2)} pips)`);
  }

  const quickAdverseRisk = clamp(
    reasons.length * 0.22
      + warnings.length * 0.1
      + (entryLocationCategory === "validPullbackEntry" ? 0.08 : 0)
      + (isFiniteNumber(bbZ1m) && bbZ1m > 1.0 ? 0.08 : 0),
    0,
    1
  );

  const maxAllowedReasons = Number(config?.entryQuality?.trendUpPullbackMaxBlockReasons ?? 0);
  const blocked = reasons.length > maxAllowedReasons;

  return {
    blocked,
    reason: blocked ? `trend-up pullback entry quality blocked: ${reasons.join("; ")}` : null,
    category: blocked ? "trend_up_pullback_quality_blocked" : "trend_up_pullback_quality_pass",
    entryLocationCategory,
    entryLocationScore: isFiniteNumber(entryLocationScore) ? entryLocationScore : null,
    multiTimeframeScore: isFiniteNumber(multiTimeframeScore) ? multiTimeframeScore : null,
    shortTermAlignmentScore: isFiniteNumber(shortTermAlignmentScore) ? shortTermAlignmentScore : null,
    shortTermExhaustionScore: isFiniteNumber(shortTermExhaustionScore) ? shortTermExhaustionScore : null,
    rsi1m: isFiniteNumber(rsi1m) ? rsi1m : null,
    bbZ1m: isFiniteNumber(bbZ1m) ? bbZ1m : null,
    rsi5m: isFiniteNumber(rsi5m) ? rsi5m : null,
    rsi10m: isFiniteNumber(rsi10m) ? rsi10m : null,
    bbZ5m: isFiniteNumber(bbZ5m) ? bbZ5m : null,
    bbZ10m: isFiniteNumber(bbZ10m) ? bbZ10m : null,
    momentum5mPips: isFiniteNumber(momentum5mPips) ? momentum5mPips : null,
    momentum10mPips: isFiniteNumber(momentum10mPips) ? momentum10mPips : null,
    quickAdverseRisk,
    reasons,
    warnings
  };
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function resolveDirectionBias(newsBias, sessionBias) {
  if (newsBias && newsBias !== "NEUTRAL") return newsBias;
  return sessionBias || "NEUTRAL";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
