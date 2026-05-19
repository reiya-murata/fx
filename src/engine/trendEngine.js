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

export function evaluateTrendEngine({ regime, ask, bid, atrValue, marketFeatures, config, regimeProfile }) {
  const pullbackCfg = config?.trendPullback || {};
  const pullbackEnabled = Boolean(pullbackCfg.enabled);
  const breakoutBbZ = Math.max(1.2, Number(pullbackCfg.breakoutBbZ || 3.2));
  const retraceBbZ = Math.max(0.4, Number(pullbackCfg.retraceBbZ || 1.1));
  const minMomentumResume = Math.max(0.01, Number(pullbackCfg.minMomentumResume || 0.08));
  const minBuyMomentum = Number(pullbackCfg.minBuyMomentum ?? 0);
  const maxBuyEntryBbZ = Number(pullbackCfg.maxBuyEntryBbZ ?? 999);
  const buyBbzBypassMomentum = Number(pullbackCfg.buyBbzBypassMomentum ?? 0.7);
  const minTrendSlope15mBuyPips = Number(pullbackCfg.minTrendSlope15mBuyPips ?? 0);
  const maxSellMomentum = Number(pullbackCfg.maxSellMomentum ?? 0);
  const minSellEntryBbZ = Number(pullbackCfg.minSellEntryBbZ ?? -999);
  const sellBbzBypassMomentum = Number(pullbackCfg.sellBbzBypassMomentum ?? -0.7);
  const maxTrendSlope15mSellPips = Number(pullbackCfg.maxTrendSlope15mSellPips ?? 0);

  if (regime === "TREND_UP") {
    const mom = Number(marketFeatures?.momentumScore || 0);
    const bbZ = Number(marketFeatures?.bbZ1m || 0);
    const slope15 = Number(marketFeatures?.trendSlope15mPips || 0);
    if (slope15 < minTrendSlope15mBuyPips) {
      return { action: "HOLD", rationale: "Trend-up blocked: 15m slope too weak", levels: null };
    }
    if (mom < minBuyMomentum) {
      return { action: "HOLD", rationale: "Trend-up waiting momentum re-acceleration", levels: null };
    }
    if (bbZ > maxBuyEntryBbZ && mom < buyBbzBypassMomentum) {
      return { action: "HOLD", rationale: "Trend-up waiting cheaper pullback entry", levels: null };
    }
    if (pullbackEnabled && bbZ >= breakoutBbZ && (bbZ > retraceBbZ || mom < minMomentumResume)) {
      return { action: "HOLD", rationale: "Trend-up pullback required before entry", levels: null };
    }
    return {
      action: "BUY",
      rationale: "Trend-up pullback re-acceleration",
      levels: buildTradeLevels(ask, "BUY", atrValue, config, regimeProfile)
    };
  }

  if (regime === "TREND_DOWN") {
    const mom = Number(marketFeatures?.momentumScore || 0);
    const bbZ = Number(marketFeatures?.bbZ1m || 0);
    const slope15 = Number(marketFeatures?.trendSlope15mPips || 0);
    if (slope15 > maxTrendSlope15mSellPips) {
      return { action: "HOLD", rationale: "Trend-down blocked: 15m slope too weak", levels: null };
    }
    if (mom > maxSellMomentum) {
      return { action: "HOLD", rationale: "Trend-down waiting momentum re-acceleration", levels: null };
    }
    if (bbZ < minSellEntryBbZ && mom > sellBbzBypassMomentum) {
      return { action: "HOLD", rationale: "Trend-down waiting higher pullback entry", levels: null };
    }
    if (pullbackEnabled && Math.abs(bbZ) >= breakoutBbZ && (Math.abs(bbZ) > retraceBbZ || mom > -minMomentumResume)) {
      return { action: "HOLD", rationale: "Trend-down pullback required before entry", levels: null };
    }
    return {
      action: "SELL",
      rationale: "Trend-down pullback re-acceleration",
      levels: buildTradeLevels(bid, "SELL", atrValue, config, regimeProfile)
    };
  }

  return { action: "HOLD", rationale: "Not trend regime", levels: null };
}
