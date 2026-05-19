export function ema(values, period) {
  if (!values.length || period <= 0) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prev = values[0];
  result.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function atr(candles, period) {
  if (candles.length < 2) return 0;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trueRanges.push(tr);
  }
  const recent = trueRanges.slice(-period);
  if (!recent.length) return 0;
  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

export function slope(values, lookback) {
  if (values.length < lookback + 1) return 0;
  const end = values[values.length - 1];
  const start = values[values.length - 1 - lookback];
  return (end - start) / lookback;
}

export function sma(values, period) {
  if (!values.length || period <= 0 || values.length < period) return null;
  const recent = values.slice(-period);
  return recent.reduce((s, v) => s + Number(v || 0), 0) / period;
}

export function stddev(values, period) {
  if (!values.length || period <= 1 || values.length < period) return null;
  const mean = sma(values, period);
  if (!Number.isFinite(mean)) return null;
  const recent = values.slice(-period);
  const variance = recent.reduce((s, v) => s + ((Number(v || 0) - mean) ** 2), 0) / period;
  return Math.sqrt(variance);
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = Number(values[i] || 0) - Number(values[i - 1] || 0);
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - (100 / (1 + rs));
}

export function macd(values, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < longPeriod + signalPeriod) {
    return { macd: null, signal: null, hist: null };
  }
  const short = ema(values, shortPeriod);
  const long = ema(values, longPeriod);
  const line = short.map((v, i) => Number(v || 0) - Number(long[i] || 0));
  const sig = ema(line, signalPeriod);
  const m = line[line.length - 1];
  const s = sig[sig.length - 1];
  return {
    macd: m,
    signal: s,
    hist: Number(m || 0) - Number(s || 0)
  };
}
