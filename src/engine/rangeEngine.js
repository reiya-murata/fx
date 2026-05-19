import { ema, rsi, slope } from "./indicators.js";

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

function countRisingPairs(values) {
  let count = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (Number(values[i]) > Number(values[i - 1])) count += 1;
  }
  return count;
}

function countFallingPairs(values) {
  let count = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (Number(values[i]) < Number(values[i - 1])) count += 1;
  }
  return count;
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "n/a";
}

function evaluateRangeMomentumBreakout({
  recent,
  hi,
  lo,
  ask,
  bid,
  atrValue,
  spreadPips,
  marketFeatures,
  config,
  regimeProfile,
  earlySpreadMax
}) {
  const cfg = config.range?.momentumBreakout || {};
  const enabled = cfg.enabled !== false;
  const diagnostics = {
    evaluated: false,
    candidateDirection: "NONE",
    passed: false,
    reasons: []
  };
  if (!enabled) {
    diagnostics.reasons.push("レンジブレイクアウト機能が無効化されています");
    return { action: "HOLD", rationale: "レンジブレイクアウト機能が無効化されています", levels: null, diagnostics };
  }

  const pipSize = Number(config.pipSize || 0.01);
  const lookbackBars = Math.max(4, Number(cfg.lookbackBars || 5));
  const window = recent.slice(-lookbackBars);
  const closes = recent.map((c) => Number(c.close));
  const highs = window.map((c) => Number(c.high));
  const lows = window.map((c) => Number(c.low));
  const close = Number(closes.at(-1));
  const rangePips = (hi - lo) / pipSize;
  const shortPeriod = Math.max(3, Number(cfg.shortMaPeriod || 5));
  const midPeriod = Math.max(shortPeriod + 1, Number(cfg.midMaPeriod || 10));
  const shortMaSeries = ema(closes, shortPeriod);
  const midMaSeries = ema(closes, midPeriod);
  const shortMa = Number(shortMaSeries.at(-1));
  const midMa = Number(midMaSeries.at(-1));
  const shortMaSlopePips = slope(shortMaSeries, Math.min(3, shortMaSeries.length - 1)) / pipSize;
  const structureMinPairs = Math.max(2, Number(cfg.minStructurePairs || 3));
  const nearBreakoutPips = Math.max(0.5, Number(cfg.nearBreakoutPips || Math.min(2.0, Math.max(0.8, rangePips * 0.1))));
  const prior = recent.slice(0, -1);
  const priorHigh = Math.max(...prior.slice(-Math.max(lookbackBars, 8)).map((c) => Number(c.high)));
  const priorLow = Math.min(...prior.slice(-Math.max(lookbackBars, 8)).map((c) => Number(c.low)));
  const spreadMax = Math.max(0.12, Number(cfg.maxSpreadPips || earlySpreadMax || config.spread?.maxPipsNormal || 0.3));
  const minEvPips = Number(cfg.minExpectedValuePips ?? -0.45);
  const mom = Number(marketFeatures?.momentumScore || 0);
  const rsiNow = Number.isFinite(Number(marketFeatures?.rsi1m)) ? Number(marketFeatures.rsi1m) : Number(rsi(closes, 14));
  const rsiPrev = Number(rsi(closes.slice(0, -1), 14));
  const rsiMinBuy = Number(cfg.rsiMinBuy || 45);
  const rsiMaxBuy = Number(cfg.rsiMaxBuy || 72);
  const rsiMinSell = Number(cfg.rsiMinSell || 28);
  const rsiMaxSell = Number(cfg.rsiMaxSell || 55);
  const risingHighs = countRisingPairs(highs);
  const risingLows = countRisingPairs(lows);
  const fallingHighs = countFallingPairs(highs);
  const fallingLows = countFallingPairs(lows);
  const buyStructure = risingHighs >= structureMinPairs - 1 && risingLows >= structureMinPairs - 1;
  const sellStructure = fallingHighs >= structureMinPairs - 1 && fallingLows >= structureMinPairs - 1;
  const priceAboveMa = Number.isFinite(shortMa) && close > shortMa;
  const priceBelowMa = Number.isFinite(shortMa) && close < shortMa;
  const maBullish = Number.isFinite(shortMa) && Number.isFinite(midMa) && (shortMa > midMa || shortMaSlopePips > 0.02);
  const maBearish = Number.isFinite(shortMa) && Number.isFinite(midMa) && (shortMa < midMa || shortMaSlopePips < -0.02);
  const nearOrBreakingHigh = Number.isFinite(priorHigh) && (close >= priorHigh - nearBreakoutPips * pipSize || highs.at(-1) >= priorHigh);
  const nearOrBreakingLow = Number.isFinite(priorLow) && (close <= priorLow + nearBreakoutPips * pipSize || lows.at(-1) <= priorLow);
  const rsiBuyOk = !Number.isFinite(rsiNow)
    || (rsiNow >= rsiMinBuy && rsiNow <= rsiMaxBuy && (!Number.isFinite(rsiPrev) || rsiNow >= rsiPrev - 1.5 || mom > 0.08));
  const rsiSellOk = !Number.isFinite(rsiNow)
    || (rsiNow >= rsiMinSell && rsiNow <= rsiMaxSell && (!Number.isFinite(rsiPrev) || rsiNow <= rsiPrev + 1.5 || mom < -0.08));
  const spreadOk = Number(spreadPips || 0) <= spreadMax;
  const buyScore = [
    buyStructure,
    priceAboveMa,
    maBullish,
    nearOrBreakingHigh,
    rsiBuyOk,
    mom >= -0.05
  ].filter(Boolean).length;
  const sellScore = [
    sellStructure,
    priceBelowMa,
    maBearish,
    nearOrBreakingLow,
    rsiSellOk,
    mom <= 0.05
  ].filter(Boolean).length;
  const minScore = Math.max(5, Number(cfg.minScore || 5));
  const direction = buyScore > sellScore ? "BUY" : (sellScore > buyScore ? "SELL" : "NONE");
  diagnostics.evaluated = true;
  diagnostics.candidateDirection = direction;
  diagnostics.buyScore = buyScore;
  diagnostics.sellScore = sellScore;
  diagnostics.shortMa = Number.isFinite(shortMa) ? Number(shortMa.toFixed(5)) : null;
  diagnostics.midMa = Number.isFinite(midMa) ? Number(midMa.toFixed(5)) : null;
  diagnostics.shortMaSlopePips = Number.isFinite(shortMaSlopePips) ? Number(shortMaSlopePips.toFixed(4)) : null;
  diagnostics.rsi1m = Number.isFinite(rsiNow) ? Number(rsiNow.toFixed(3)) : null;
  diagnostics.nearBreakoutPips = Number(nearBreakoutPips.toFixed(3));
  diagnostics.spreadGatePips = Number(spreadMax.toFixed(3));

  if (direction === "BUY") {
    if (!buyStructure) diagnostics.reasons.push("higher-high/higher-low structure not confirmed");
    if (!priceAboveMa) diagnostics.reasons.push("price not above short MA");
    if (!maBullish) diagnostics.reasons.push("short MA not above/rising versus mid MA");
    if (!nearOrBreakingHigh) diagnostics.reasons.push("not near or above recent high");
    if (!rsiBuyOk) diagnostics.reasons.push(`rsi1m not supportive for buy (${fmt(rsiNow, 1)})`);
    if (mom < -0.05) diagnostics.reasons.push(`買いにはモメンタムが弱すぎます (${fmt(mom, 3)})`);
  } else if (direction === "SELL") {
    if (!sellStructure) diagnostics.reasons.push("lower-high/lower-low structure not confirmed");
    if (!priceBelowMa) diagnostics.reasons.push("price not below short MA");
    if (!maBearish) diagnostics.reasons.push("short MA not below/falling versus mid MA");
    if (!nearOrBreakingLow) diagnostics.reasons.push("not near or below recent low");
    if (!rsiSellOk) diagnostics.reasons.push(`rsi1m not supportive for sell (${fmt(rsiNow, 1)})`);
    if (mom > 0.05) diagnostics.reasons.push(`売りにはモメンタムが強すぎます (${fmt(mom, 3)})`);
  } else {
    diagnostics.reasons.push("明確なモメンタム方向がありません");
  }
  if (!spreadOk) diagnostics.reasons.push(`モメンタムブレイクにはスプレッドが広すぎます (${fmt(spreadPips)} > ${fmt(spreadMax)})`);
  if (direction === "NONE" || Math.max(buyScore, sellScore) < minScore || !spreadOk) {
    return {
      action: "HOLD",
      rationale: `レンジブレイクアウト未確定; ブロック理由: ${diagnostics.reasons.join(", ")}`,
      levels: null,
      diagnostics
    };
  }

  const levels = buildTradeLevels(direction === "BUY" ? ask : bid, direction, atrValue, config, regimeProfile);
  const evRaw = expectedValuePips(levels, direction, pipSize);
  const costPips = estimateRoundTripCostPips(levels, spreadPips, config);
  const ev = evRaw - costPips + Math.max(-0.12, Math.min(0.12, mom * 0.12));
  diagnostics.expectedValueRawPips = Number(evRaw.toFixed(4));
  diagnostics.estimatedCostPips = Number(costPips.toFixed(4));
  diagnostics.expectedValuePips = Number(ev.toFixed(4));
  diagnostics.minExpectedValuePips = Number(minEvPips.toFixed(4));
  if (ev < minEvPips) {
    diagnostics.reasons.push(`期待値が低すぎます (${fmt(ev)} < ${fmt(minEvPips)})`);
    return {
      action: "HOLD",
      rationale: `レンジブレイクアウト未確定; ブロック理由: ${diagnostics.reasons.join(", ")}`,
      levels: null,
      diagnostics
    };
  }

  diagnostics.passed = true;
  return {
    action: direction,
    rationale: `Range momentum breakout candidate (${direction}); score ${Math.max(buyScore, sellScore)}/${minScore}, EV ${fmt(ev)}pips`,
    levels,
    diagnostics
  };
}

export function evaluateRangeEngine({
  regime,
  candles1m,
  ask,
  bid,
  atrValue,
  spreadPips = 0,
  marketFeatures = null,
  config,
  regimeProfile
}) {
  if (regime !== "RANGE") {
    return { action: "HOLD", rationale: "レンジ相場ではありません", levels: null };
  }
  const recent = candles1m.slice(-20);
  if (recent.length < 5) {
    return { action: "HOLD", rationale: "レンジ判定: キャンドルデータが不足しています", levels: null };
  }
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  const rangePips = (hi - lo) / config.pipSize;
  if (rangePips > config.range.maxRangePips) {
    return { action: "HOLD", rationale: "レンジ幅が広すぎます", levels: null };
  }
  const close = Number(recent[recent.length - 1].close);
  const prev = Number(recent[recent.length - 2].close);
  const prev2 = Number(recent[recent.length - 3].close);
  const edgeFactor = Math.max(0.08, Number(config.range?.edgeFactor || 0.12));
  const edge = (hi - lo) * edgeFactor;
  const earlyEnabled = Boolean(config.range?.earlyReversalEnabled);
  const earlyEdgeFactor = Math.max(0.12, Number(config.range?.earlyReversalEdgeFactor || 0.16));
  const earlyEdge = (hi - lo) * earlyEdgeFactor;
  const earlySpreadMax = Math.max(0.12, Number(config.range?.earlyReversalMaxSpreadPips || 0.26));
  const isGmoHttpPaperLive = Boolean(marketFeatures?.isGmoHttpPaperLive);
  const relaxedSpreadMax = isGmoHttpPaperLive ? 0.55 : earlySpreadMax;

  const mom = Number(marketFeatures?.momentumScore || 0);
  const bullishReversal = close > prev && prev <= prev2;
  const bearishReversal = close < prev && prev >= prev2;

  const rsi1m = Number(marketFeatures?.rsi1m ?? 50);
  const bbZ1m = Number(marketFeatures?.bbZ1m ?? 0);
  const lowerDistPips = (close - lo) / config.pipSize;
  const upperDistPips = (hi - close) / config.pipSize;
  const edgeThresholdPips = edge / config.pipSize;
  const earlyEdgeThresholdPips = earlyEdge / config.pipSize;
  const isNearLowerEdge = lowerDistPips <= Math.max(edgeThresholdPips, earlyEdgeThresholdPips) * 1.5;
  const isNearUpperEdge = upperDistPips <= Math.max(edgeThresholdPips, earlyEdgeThresholdPips) * 1.5;

  let lowerScore = 0;
  if (isNearLowerEdge) {
    if (lowerDistPips <= edgeThresholdPips) lowerScore += 2;
    else if (lowerDistPips <= earlyEdgeThresholdPips * 1.5) lowerScore += 1;
    if (rsi1m <= 35) lowerScore += 2;
    else if (rsi1m <= 45) lowerScore += 1;
    if (bbZ1m <= -1.5) lowerScore += 2;
    else if (bbZ1m <= -1.0) lowerScore += 1;
    if (mom >= 0.1) lowerScore += 1;
    else if (mom >= -0.2) lowerScore += 0.5;
    if (close > prev) lowerScore += 1.5;
  }

  let upperScore = 0;
  if (isNearUpperEdge) {
    if (upperDistPips <= edgeThresholdPips) upperScore += 2;
    else if (upperDistPips <= earlyEdgeThresholdPips * 1.5) upperScore += 1;
    if (rsi1m >= 65) upperScore += 2;
    else if (rsi1m >= 55) upperScore += 1;
    if (bbZ1m >= 1.5) upperScore += 2;
    else if (bbZ1m >= 1.0) upperScore += 1;
    if (mom <= -0.1) upperScore += 1;
    else if (mom <= 0.2) upperScore += 0.5;
    if (close < prev) upperScore += 1.5;
  }

  const syntheticReversalThreshold = 4.5;
  const isStrongLower = isNearLowerEdge && (lowerScore >= syntheticReversalThreshold || (bullishReversal && close <= lo + edge));
  const isStrongUpper = isNearUpperEdge && (upperScore >= syntheticReversalThreshold || (bearishReversal && close >= hi - edge));

  const appliedSpreadLimitPips = (isStrongLower || isStrongUpper) ? relaxedSpreadMax : earlySpreadMax;
  const spreadRelaxedForGmoHttp = appliedSpreadLimitPips > earlySpreadMax;
  const spreadOk = Number(spreadPips || 0) <= appliedSpreadLimitPips;

  const bullishEarly = close > prev && close <= lo + earlyEdge && spreadOk && mom > -0.35;
  const bearishEarly = close < prev && close >= hi - earlyEdge && spreadOk && mom < 0.35;

  const buildRangeMetrics = (score) => ({
    decisionCategory: "RANGE_BASE",
    rangeQuality: "STRONG_REVERSAL",
    syntheticReversalScore: score,
    syntheticReversalThreshold,
    spreadRelaxedForGmoHttp,
    originalSpreadLimitPips: earlySpreadMax,
    appliedSpreadLimitPips,
    rangeDistanceToEdgePips: isNearLowerEdge ? lowerDistPips : upperDistPips,
    rangeWidthRatio: rangePips / (config.range.maxRangePips || 1)
  });

  if (close <= lo + edge && bullishReversal && spreadOk) {
    return {
      action: "BUY",
      rationale: "Range lower-edge confirmed mean reversion",
      levels: buildTradeLevels(ask, "BUY", atrValue, config, regimeProfile),
      metrics: buildRangeMetrics(lowerScore)
    };
  }
  if (earlyEnabled && (bullishEarly || (isNearLowerEdge && spreadOk && lowerScore >= syntheticReversalThreshold))) {
    const isSynthetic = !bullishEarly;
    return {
      action: "BUY",
      rationale: isSynthetic ? `Range lower-edge synthetic reversal (score: ${lowerScore})` : "Range lower-edge early reversal",
      levels: buildTradeLevels(ask, "BUY", atrValue, config, regimeProfile),
      metrics: buildRangeMetrics(lowerScore)
    };
  }
  if (close >= hi - edge && bearishReversal && spreadOk) {
    return {
      action: "SELL",
      rationale: "Range upper-edge confirmed mean reversion",
      levels: buildTradeLevels(bid, "SELL", atrValue, config, regimeProfile),
      metrics: buildRangeMetrics(upperScore)
    };
  }
  if (earlyEnabled && (bearishEarly || (isNearUpperEdge && spreadOk && upperScore >= syntheticReversalThreshold))) {
    const isSynthetic = !bearishEarly;
    return {
      action: "SELL",
      rationale: isSynthetic ? `Range upper-edge synthetic reversal (score: ${upperScore})` : "Range upper-edge early reversal",
      levels: buildTradeLevels(bid, "SELL", atrValue, config, regimeProfile),
      metrics: buildRangeMetrics(upperScore)
    };
  }


  const momentumBreakout = evaluateRangeMomentumBreakout({
    recent,
    hi,
    lo,
    ask,
    bid,
    atrValue,
    spreadPips,
    marketFeatures,
    config,
    regimeProfile,
    earlySpreadMax
  });
  if (momentumBreakout.action !== "HOLD") {
    return momentumBreakout;
  }

  const failedReasons = [];
  let nearMiss = false;

  if (isNearLowerEdge) {
    nearMiss = true;
    if (close > lo + Math.max(edge, earlyEdge)) failedReasons.push("レンジ下限に十分近くありません");
    if (close <= prev) failedReasons.push("反発を示す陽線確定がありません");
    if (prev > prev2) failedReasons.push("直前の下落モメンタムがありません");
    if (!spreadOk) failedReasons.push("早期反発狙いにはスプレッドが広すぎます");
    if (mom <= -0.35) failedReasons.push("早期反発狙いには下落モメンタムが強すぎます");
  } else if (isNearUpperEdge) {
    nearMiss = true;
    if (close < hi - Math.max(edge, earlyEdge)) failedReasons.push("レンジ上限に十分近くありません");
    if (close >= prev) failedReasons.push("反落を示す陰線確定がありません");
    if (prev < prev2) failedReasons.push("直前の上昇モメンタムがありません");
    if (!spreadOk) failedReasons.push("早期反発狙いにはスプレッドが広すぎます");
    if (mom >= 0.35) failedReasons.push("早期反発狙いには上昇モメンタムが強すぎます");
  } else {
    failedReasons.push("価格がレンジの中間付近にあります");
  }

  const rangeEdgeScore = isNearLowerEdge ? lowerDistPips : (isNearUpperEdge ? upperDistPips : Math.min(lowerDistPips, upperDistPips));
  const rangeEdgeThreshold = Math.max(edgeThresholdPips, earlyEdgeThresholdPips);

  const diagnostics = {
    rangeEdgeScore: Number(rangeEdgeScore.toFixed(4)),
    rangeEdgeThreshold: Number(rangeEdgeThreshold.toFixed(4)),
    rsi1m: Number(marketFeatures?.rsi1m || 0),
    bbZ1m: Number(marketFeatures?.bbZ1m || 0),
    momentumScore: mom,
    trendBias: String(marketFeatures?.trendBias || "NEUTRAL"),
    atrPips1m: Number(marketFeatures?.atrPips1m || 0),
    rangeMomentumBreakout: momentumBreakout.diagnostics,
    failedReasons,
    nearMiss
  };

  const momentumReasons = momentumBreakout.diagnostics?.evaluated
    ? `; レンジブレイクアウト未確定: ${momentumBreakout.diagnostics.reasons.join(", ")}`
    : "";
  const rationale = `レンジ端での反発根拠が未確定です; ブロック理由: ${failedReasons.join(", ")}${momentumReasons}`;

  return { action: "HOLD", rationale, levels: null, diagnostics };
}
