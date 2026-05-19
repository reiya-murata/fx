import { atr, ema, slope } from "./indicators.js";

export const Regime = Object.freeze({
  TREND_UP: "TREND_UP",
  TREND_DOWN: "TREND_DOWN",
  RANGE: "RANGE",
  HIGH_VOLATILITY: "HIGH_VOLATILITY"
});

export function detectRegime({ candles1m, candles5m, candles15m, spreadPips, config }) {
  const closes5m = candles5m.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);

  if (closes5m.length < config.trend.longEmaPeriod || closes15m.length < config.trend.longEmaPeriod) {
    return Regime.RANGE;
  }

  const emaShort5 = ema(closes5m, config.trend.shortEmaPeriod);
  const emaLong5 = ema(closes5m, config.trend.longEmaPeriod);
  const emaShort15 = ema(closes15m, config.trend.shortEmaPeriod);
  const emaLong15 = ema(closes15m, config.trend.longEmaPeriod);

  const atrNow = atr(candles1m, config.volatility.atrPeriod);
  const atrBase = atr(candles1m.slice(0, -config.volatility.atrPeriod), config.volatility.atrPeriod) || atrNow;

  const highVol = spreadPips > config.spread.highVolatilityPips || (atrBase > 0 && atrNow > atrBase * config.volatility.highVolMultiplier);
  if (highVol) {
    return Regime.HIGH_VOLATILITY;
  }

  const gap5 = (emaShort5[emaShort5.length - 1] - emaLong5[emaLong5.length - 1]) / config.pipSize;
  const gap15 = (emaShort15[emaShort15.length - 1] - emaLong15[emaLong15.length - 1]) / config.pipSize;
  const slope5 = slope(emaLong5, config.trend.slopeLookback);

  if (gap5 > config.trend.minTrendEmaGapPips && gap15 > 0 && slope5 > 0) {
    return Regime.TREND_UP;
  }

  if (gap5 < -config.trend.minTrendEmaGapPips && gap15 < 0 && slope5 < 0) {
    return Regime.TREND_DOWN;
  }

  const recent = candles1m.slice(-config.range.lookbackCandles);
  const high = Math.max(...recent.map((c) => c.high));
  const low = Math.min(...recent.map((c) => c.low));
  const rangePips = (high - low) / config.pipSize;
  if (rangePips <= config.range.maxRangePips) {
    return Regime.RANGE;
  }

  return Regime.RANGE;
}

export function smoothRegime(baseRegime, trades = [], config = {}) {
  const smoothCfg = config?.regimeSmoothing || {};
  if (!Boolean(smoothCfg.enabled)) return baseRegime;
  const lookback = Math.max(5, Number(smoothCfg.lookbackTrades || 40));
  const stayBias = Number(smoothCfg.stayBias || 0.16);
  const list = (Array.isArray(trades) ? [...trades] : [])
    .filter((t) => typeof t?.regime === "string")
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0))
    .slice(-lookback);
  if (!list.length) return baseRegime;
  const count = {
    [Regime.TREND_UP]: 0,
    [Regime.TREND_DOWN]: 0,
    [Regime.RANGE]: 0,
    [Regime.HIGH_VOLATILITY]: 0
  };
  for (const t of list) {
    const r = t.regime;
    if (count[r] !== undefined) count[r] += 1;
  }
  const total = Object.values(count).reduce((s, v) => s + v, 0) || 1;
  const prev = String(list[list.length - 1]?.regime || "");
  const baseScore = {
    [Regime.TREND_UP]: 0.2,
    [Regime.TREND_DOWN]: 0.2,
    [Regime.RANGE]: 0.2,
    [Regime.HIGH_VOLATILITY]: 0.2
  };
  if (baseScore[baseRegime] !== undefined) baseScore[baseRegime] += 0.55;
  for (const r of Object.keys(baseScore)) {
    baseScore[r] += (count[r] / total) * 0.18;
    if (r === prev) baseScore[r] += stayBias;
  }
  let best = baseRegime;
  let bestScore = -1e9;
  for (const [r, s] of Object.entries(baseScore)) {
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}
