function seeded(seed) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

export function generateMarketSnapshot(basePrice = 150.0, spreadPips = 0.18) {
  const seed = Math.floor(Date.now() / 1000);
  const rand = seeded(seed);
  const jitter = (rand() - 0.5) * 0.12;
  const mid = basePrice + jitter;
  const pip = 0.01;
  const spread = spreadPips * pip;

  const bid = Number((mid - spread / 2).toFixed(3));
  const ask = Number((mid + spread / 2).toFixed(3));

  return {
    symbol: "USDJPY",
    bid,
    ask,
    spreadPips
  };
}

function makeCandles(base, count, step, rand) {
  const out = [];
  let p = base;
  for (let i = 0; i < count; i += 1) {
    const drift = (rand() - 0.48) * step;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + step * (0.2 + rand() * 0.3);
    const low = Math.min(open, close) - step * (0.2 + rand() * 0.3);
    out.push({
      open: Number(open.toFixed(3)),
      high: Number(high.toFixed(3)),
      low: Number(low.toFixed(3)),
      close: Number(close.toFixed(3))
    });
    p = close;
  }
  return out;
}

export function generateCandleSets(anchorPrice = 150.0) {
  const seed = Math.floor(Date.now() / 1000);
  const rand = seeded(seed + 97);
  return {
    candles1m: makeCandles(anchorPrice, 180, 0.03, rand),
    candles5m: makeCandles(anchorPrice - 0.2, 180, 0.05, rand),
    candles15m: makeCandles(anchorPrice - 0.4, 180, 0.08, rand)
  };
}
