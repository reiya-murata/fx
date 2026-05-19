import { atr, ema, macd, rsi, slope, sma, stddev } from "../engine/indicators.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function buildMarketFeatureContext({ candles1m = [], candles5m = [], candles15m = [], pipSize = 0.01, news = null }) {
  const close1 = candles1m.map((c) => Number(c.close));
  const close5 = candles5m.map((c) => Number(c.close));
  const close15 = candles15m.map((c) => Number(c.close));

  if (close1.length < 40 || close5.length < 30 || close15.length < 20) {
    return {
      ready: false,
      confidenceDelta: 0,
      momentumScore: 0,
      trendBias: "NEUTRAL",
      rsi1m: null,
      macdHist1m: null,
      bbZ1m: null,
      atrPips1m: null,
      trendSlope15mPips: null,
      economicPressure: Number(news?.shortTermRiskLevel || 0)
    };
  }

  const ema20 = ema(close1, 20);
  const ema50 = ema(close1, 50);
  const emaGapPips = ((ema20.at(-1) - ema50.at(-1)) / pipSize);

  const rsi1m = Number(rsi(close1, 14));
  const macd1 = macd(close1, 12, 26, 9);
  const ma20 = sma(close1, 20);
  const sd20 = stddev(close1, 20);
  const bbZ1m = sd20 && sd20 > 0 ? (close1.at(-1) - ma20) / sd20 : 0;
  const atrPips1m = atr(candles1m, 14) / pipSize;

  const ema15 = ema(close15, 21);
  const slope15 = slope(ema15, 8) / pipSize;
  const ema5 = ema(close5, 21);
  const slope5 = slope(ema5, 6) / pipSize;

  const trendScore = clamp(emaGapPips * 0.08 + slope15 * 0.2 + slope5 * 0.12, -1.2, 1.2);
  const oscPenalty = clamp((Math.abs(bbZ1m) - 1.4) * 0.08 + (Math.abs(rsi1m - 50) / 50 - 0.5) * 0.05, 0, 0.2);
  const economicPressure = clamp(Number(news?.shortTermRiskLevel || 0) + Math.abs(Number(news?.score || 0)) * 0.35, 0, 1);

  const momentumScore = clamp(trendScore - oscPenalty - economicPressure * 0.22, -1, 1);
  const confidenceDelta = clamp(momentumScore * 0.08 - economicPressure * 0.05, -0.12, 0.12);
  const trendBias = momentumScore > 0.12 ? "BUY" : (momentumScore < -0.12 ? "SELL" : "NEUTRAL");

  return {
    ready: true,
    confidenceDelta: Number(confidenceDelta.toFixed(4)),
    momentumScore: Number(momentumScore.toFixed(4)),
    trendBias,
    rsi1m: Number(rsi1m.toFixed(3)),
    macdHist1m: Number((macd1.hist || 0).toFixed(6)),
    bbZ1m: Number(bbZ1m.toFixed(4)),
    atrPips1m: Number(atrPips1m.toFixed(4)),
    trendSlope15mPips: Number(slope15.toFixed(4)),
    economicPressure: Number(economicPressure.toFixed(4))
  };
}
