const TF_TICKS = {
  "1m": 12,
  "15m": 180
};

function toCandle(price) {
  return { open: price, high: price, low: price, close: price, ts: new Date().toISOString() };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function aggregate(candles, groupSize) {
  const out = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const chunk = candles.slice(i, i + groupSize);
    if (!chunk.length) continue;
    out.push({
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      ts: chunk[chunk.length - 1].ts
    });
  }
  return out;
}

export class MarketSimulator {
  constructor({ basePrice = 150.0, spreadPips = 0.18, pipSize = 0.01 } = {}) {
    this.pipSize = pipSize;
    this.spreadPips = spreadPips;
    this.mid = basePrice;
    this.tickCount = 0;
    this.current1m = toCandle(this.mid);
    this.candles1m = [];

    for (let i = 0; i < 220; i += 1) {
      this.step();
    }
  }

  step() {
    this.tickCount += 1;

    const drift = (Math.random() - 0.49) * 0.03;
    const microTrend = Math.sin(this.tickCount / 70) * 0.004;
    this.mid = clamp(this.mid + drift + microTrend, 130, 180);

    this.current1m.high = Math.max(this.current1m.high, this.mid);
    this.current1m.low = Math.min(this.current1m.low, this.mid);
    this.current1m.close = this.mid;
    this.current1m.ts = new Date().toISOString();

    if (this.tickCount % TF_TICKS["1m"] === 0) {
      this.current1m.ts = new Date().toISOString();
      this.candles1m.push({ ...this.current1m });
      this.candles1m = this.candles1m.slice(-5000);
      this.current1m = toCandle(this.mid);
    }

    return this.getTicker();
  }

  getTicker() {
    const spread = this.spreadPips * this.pipSize;
    return {
      symbol: "USDJPY",
      bid: Number((this.mid - spread / 2).toFixed(3)),
      ask: Number((this.mid + spread / 2).toFixed(3)),
      spreadPips: Number(this.spreadPips.toFixed(2)),
      ts: new Date().toISOString()
    };
  }

  getCandles(tf = "1m", limit = 120) {
    const safeLimit = Math.max(10, Math.min(Number(limit) || 120, 500));
    const base = [...this.candles1m, { ...this.current1m }];
    if (tf === "1m") {
      return base.slice(-safeLimit);
    }
    if (tf === "5m") {
      return aggregate(base, 5).slice(-safeLimit);
    }
    if (tf === "15m") {
      return aggregate(base, 15).slice(-safeLimit);
    }
    if (tf === "1h") {
      return aggregate(base, 60).slice(-safeLimit);
    }
    if (tf === "1d") {
      return aggregate(base, 1440).slice(-safeLimit);
    }
    return base.slice(-safeLimit);
  }

  getDecisionCandles() {
    return {
      candles1m: this.getCandles("1m", 180),
      candles5m: this.getCandles("5m", 180),
      candles15m: this.getCandles("15m", 180)
    };
  }
}
